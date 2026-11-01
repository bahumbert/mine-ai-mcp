// Where chat commands come from and where the answers go (spec 2026-10-30-in-game-bot-commands D2-D5): the local
// server's console, the running bots' hosts, and the listener child when no bot of ours is on a remote server.
import { z } from "zod";
import { CONTROL_HEADER } from "../control.ts";
import { ListenerSupervisor, type ListenerProcess } from "../listener/supervisor.ts";
import { spawnListenerProcess } from "../listener/spawn-listener.ts";
import { listPersonas } from "../personas.ts";
import { startBot, startablePersonas, stopBot, writeOtherAgents } from "../stack-bots.ts";
import type { ChatCommandsHandle, RunningBot, StackState } from "../stack-state.ts";
import { chatAudience, localServerIsLoopbackOnly } from "./audience.ts";
import { runChatCommand, type BotControl } from "./commands.ts";
import { isCommandLine, parseChatCommand, parseConsoleChat } from "./parse.ts";
import { CommandGate, type CommandLine } from "./policy.ts";
import { tellrawLine, toWhisperLines } from "./reply.ts";

/** What the sources take from outside, so a test starts no process, opens no socket and waits no real time. */
export interface ChatCommandDeps {
  fetch: typeof fetch;
  /** The monotonic clock: cooldowns, poll ages and answer deadlines. */
  now(): number;
  /** The epoch time, only to compare with the host's ISO `at` stamp. */
  wallNow(): number;
  sleep(ms: number): Promise<void>;
  say(line: string): void;
  spawnListener(): ListenerProcess;
}

/** The real dependencies of a running stack: its own fetch, clock and console, and the listener child. */
export function chatCommandDeps(state: StackState): ChatCommandDeps {
  const { fetch, now, wallNow, sleep, say } = state.deps;
  return { fetch, now, wallNow, sleep, say, spawnListener: () => spawnListenerProcess(state) };
}

/** A host that does not answer in this time is silent for this round only; its own loop tries again, the others never wait for it. */
const HOST_POLL_TIMEOUT_MS = 2_000;
/** A whisper waits for the server's echo (up to 5 s in `send_message`) before the host answers. */
const HOST_WHISPER_TIMEOUT_MS = 8_000;
/** A host counts as reading while it answered within this many poll periods (spec D4). */
const READER_POLL_PERIODS = 3;
/** Two hosts stamp a line they both heard with their own clocks, a few ms apart; the same words from one sender closer than this are one line. */
const SAME_LINE_WINDOW_MS = 1_000;
/** An answer with no way out looks again this often (a bot that came up, the listener that joined). */
const ANSWER_RETRY_MS = 250;
const REFUSAL_ANSWER = "You may not give bot commands here. Ask the server owner to add your name to commands.players.";

const hostReplySchema = z.object({
  epoch: z.string(),
  lastSeq: z.number().int().nonnegative(),
  commands: z.array(z.object({ seq: z.number().int(), username: z.string(), channel: z.enum(["chat", "whisper"]), message: z.string(), at: z.string() })),
});
type HostReply = z.infer<typeof hostReplySchema>;

/** The poll cursor of one running bot's host. */
interface HostPoller {
  readonly bot: RunningBot;
  /** Order in which hosts were first seen running: the oldest one that answers is the reader. */
  readonly order: number;
  epoch: string | null;
  seq: number;
  lastOkAt: number | null;
}

/** Where a command line was heard, and so where its answer goes when it was a whisper. */
type LineSource = { readonly kind: "console" } | { readonly kind: "host"; readonly poller: HostPoller } | { readonly kind: "listener" };

/** Starts the sources the settings ask for; `stop()` ends them. Nothing starts with `commands.enabled` false or no server set. */
export function startChatCommands(state: StackState, deps: ChatCommandDeps): ChatCommandsHandle {
  if (!state.settings.commands.enabled || state.settings.server.kind === "none") return { stop: async () => {} };
  const sources = new ChatCommandSources(state, deps);
  sources.start();
  return { stop: () => sources.stop() };
}

class ChatCommandSources {
  private stopped = false;
  private answersOff = false;
  /** Settles when `stop()` begins, so an answer waiting for a way out ends then, not at its next look. */
  private readonly stopped$: Promise<void>;
  private endWaits: () => void = () => {};
  private pollerCount = 0;
  private listenerWasJoined = false;
  /** Last time any host answered a poll; starts at the sources' start so a bot still starting does not call the listener in. */
  private lastHostOkAt: number;
  private readonly pollers = new Map<RunningBot, HostPoller>();
  private publicLinesRun: { key: string; heardAt: number }[] = [];
  private readonly gate: CommandGate;
  private readonly listener: ListenerSupervisor | null;
  private readonly anyoneMay: boolean;
  private readonly isRemote: boolean;
  private readonly control: BotControl;

  constructor(private readonly state: StackState, private readonly deps: ChatCommandDeps) {
    const { commands } = state.settings;
    const { manifest } = state;
    this.stopped$ = new Promise<void>((resolve) => (this.endWaits = resolve));
    this.isRemote = state.settings.server.kind === "remote";
    this.lastHostOkAt = deps.now();
    this.gate = new CommandGate({ now: deps.now, cooldownMs: manifest.commands.cooldownMs, refusalEveryMs: manifest.commands.refusalEveryMs });
    this.anyoneMay = chatAudience(state.settings, state.root) === "everyone";
    this.control = {
      personas: () => startablePersonas(state.root),
      bots: () => [...state.bots.values()].map(({ id, username, status }) => ({ id, username, status })),
      start: (id) => startBot(state, id),
      stop: async (id) => {
        try {
          return await stopBot(state, id);
        } finally {
          this.afterOwnStop();
        }
      },
    };
    this.listener = this.isRemote
      ? new ListenerSupervisor({ spawn: deps.spawnListener, now: deps.now, sleep: deps.sleep, say: deps.say, onCommand: (line) => this.handle(line, { kind: "listener" }), name: commands.listenerName, retryFirstMs: manifest.commands.listenerAfterMs })
      : null;
  }

  start(): void {
    if (!this.isRemote) this.startConsoleTap();
    this.sayWhenLocalServerIsOpen();
    void this.runRounds();
  }

  /** Ends the polling and the listener, then drops every answer still to come; a command in flight is not awaited (`stopStack` ends its start). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.answersOff = true;
    this.endWaits();
    this.state.onServerLine = undefined;
    await this.listener?.stop();
    this.setListenerJoined(false);
  }

  // ---------- the sources ----------

  private startConsoleTap(): void {
    const { prefix } = this.state.settings.commands;
    this.state.onServerLine = (line) => {
      const chat = parseConsoleChat(line);
      if (chat !== null && isCommandLine(chat.message, prefix)) this.handle({ username: chat.username, channel: "chat", message: chat.message }, { kind: "console" });
    };
  }

  private sayWhenLocalServerIsOpen(): void {
    if (this.state.settings.server.kind === "local" && !localServerIsLoopbackOnly(this.state.root)) {
      this.deps.say("The local Minecraft server does not listen on 127.0.0.1 only (server-ip in server.properties), so chat commands follow the remote rules: only the names in commands.players may give them.");
    }
  }

  /** Once per poll period: new hosts get a poll loop of their own, and the listener joins or leaves. */
  private async runRounds(): Promise<void> {
    while (!this.stopped) {
      this.startPollersForRunningBots();
      this.updateListener();
      await this.deps.sleep(this.state.manifest.commands.pollMs);
    }
  }

  private startPollersForRunningBots(): void {
    for (const bot of this.state.bots.values()) {
      if (bot.status !== "running" || this.pollers.has(bot)) continue;
      const poller: HostPoller = { bot, order: this.pollerCount++, epoch: null, seq: 0, lastOkAt: null };
      this.pollers.set(bot, poller);
      void this.pollHost(poller);
    }
  }

  private isPolled(poller: HostPoller): boolean {
    return !this.stopped && poller.bot.status === "running" && this.state.bots.get(poller.bot.id) === poller.bot;
  }

  /** One host's loop: its own pace and its own timeout, so a frozen host holds up nobody else. */
  private async pollHost(poller: HostPoller): Promise<void> {
    while (this.isPolled(poller)) {
      if ((await this.pollOnce(poller)) === "epoch-changed") await this.pollOnce(poller);
      await this.deps.sleep(this.state.manifest.commands.pollMs);
    }
    if (this.pollers.get(poller.bot) === poller) this.pollers.delete(poller.bot);
  }

  private async pollOnce(poller: HostPoller): Promise<"ok" | "failed" | "epoch-changed"> {
    const reply = await this.fetchHostCommands(poller);
    if (reply === null) return "failed";
    const now = this.deps.now();
    poller.lastOkAt = now;
    // A poll of a host we have since stopped, still in flight, must not tell the listener a host is in.
    if (this.pollers.get(poller.bot) === poller) this.lastHostOkAt = now;
    if (poller.epoch !== null && poller.epoch !== reply.epoch) {
      // The runtime restarted: its numbers start again, and the reply was cut at the old cursor.
      poller.epoch = reply.epoch;
      poller.seq = 0;
      return "epoch-changed";
    }
    poller.epoch = reply.epoch;
    poller.seq = Math.max(poller.seq, reply.lastSeq);
    for (const command of reply.commands) this.acceptFromHost(poller, command);
    return "ok";
  }

  private async fetchHostCommands(poller: HostPoller): Promise<HostReply | null> {
    try {
      const response = await this.deps.fetch(`http://127.0.0.1:${poller.bot.hostPort}/chat-commands?after=${poller.seq}`, { headers: { [CONTROL_HEADER]: "1" }, signal: AbortSignal.timeout(HOST_POLL_TIMEOUT_MS) });
      if (!response.ok) return null;
      const parsed = hostReplySchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** A line older than `maxAgeMs` when it arrives is dropped (no replay after a stall); public chat is taken from the reader only. */
  private acceptFromHost(poller: HostPoller, command: HostReply["commands"][number]): void {
    const heardAt = Date.parse(command.at);
    if (!(this.deps.wallNow() - heardAt <= this.state.manifest.commands.maxAgeMs)) return;
    if (command.channel === "chat") {
      if (this.reader() !== poller) return;
      if (this.alreadyRunPublicLine(command.username, command.message, heardAt)) return;
    }
    this.handle({ username: command.username, channel: command.channel, message: command.message }, { kind: "host", poller });
  }

  /**
   * A public line every host heard, taken again from a host that was not the reader when it first ran (the old reader
   * answers again, a handover): the same sender and words within `SAME_LINE_WINDOW_MS` are one line, whatever clock stamped them.
   */
  private alreadyRunPublicLine(username: string, message: string, heardAt: number): boolean {
    const maxAgeMs = this.state.manifest.commands.maxAgeMs;
    this.publicLinesRun = this.publicLinesRun.filter((entry) => this.deps.wallNow() - entry.heardAt <= maxAgeMs);
    const key = `${username.toLowerCase()}\n${message}`;
    if (this.publicLinesRun.some((entry) => entry.key === key && Math.abs(entry.heardAt - heardAt) <= SAME_LINE_WINDOW_MS)) return true;
    this.publicLinesRun.push({ key, heardAt });
    return false;
  }

  /** The host that reads public chat: of those that answered within 3 poll periods, the one running longest. A local server has none: its console is the public source. */
  private reader(): HostPoller | null {
    if (!this.isRemote) return null;
    return this.readingPollers().sort((a, b) => a.order - b.order)[0] ?? null;
  }

  private readingPollers(): HostPoller[] {
    const { pollMs } = this.state.manifest.commands;
    const now = this.deps.now();
    return [...this.pollers.values()].filter((poller) => poller.lastOkAt !== null && now - poller.lastOkAt <= READER_POLL_PERIODS * pollMs);
  }

  // ---------- the listener ----------

  /**
   * A bot stopped by a chat command is gone for good: it stops counting as a host now, and with no other host reading the
   * listener is called in at once (not after `listenerAfterMs`, which rides out a host that is only slow to answer polls),
   * so the last answer of the stop has a way to the player. A bot whose stop failed and is still polled keeps its poller.
   */
  private afterOwnStop(): void {
    for (const [bot, poller] of this.pollers) if (!this.isPolled(poller)) this.pollers.delete(bot);
    if (this.readingPollers().length > 0) return;
    this.lastHostOkAt = this.deps.now() - this.state.manifest.commands.listenerAfterMs;
    this.updateListener();
  }

  private updateListener(): void {
    if (this.listener === null) return;
    const { listenerAfterMs } = this.state.manifest.commands;
    const noHostIsIn = this.deps.now() - this.lastHostOkAt >= listenerAfterMs;
    this.listener.setWanted(!this.stopped && this.state.settings.commands.players.length > 0 && this.state.serverTarget !== null && noHostIsIn);
    this.setListenerJoined(this.listener.isJoined());
  }

  /** The brains must not answer the listener: its name goes in the other-agents file while it is on the server. */
  private setListenerJoined(joined: boolean): void {
    if (joined === this.listenerWasJoined) return;
    this.listenerWasJoined = joined;
    this.state.listenerJoined = joined ? this.state.settings.commands.listenerName : null;
    writeOtherAgents(this.state);
  }

  // ---------- one command line ----------

  /** Runs at once, never behind another command: a start that takes 90 s does not hold up a stop typed meanwhile. */
  private handle(line: CommandLine, source: LineSource): void {
    if (this.stopped) return;
    const command = parseChatCommand(line.message, this.state.settings.commands.prefix);
    if (command === null) return;
    const decision = this.gate.check(line, { anyoneMay: this.anyoneMay, players: this.state.settings.commands.players, ourNames: this.ourNames() });
    if (decision === "ignore") return;
    const answer = (text: string): Promise<void> => this.answer(line, source, text);
    const run = decision === "refuse" ? this.refuse(line, answer) : this.run(line, command, answer);
    run.catch((error: unknown) => this.deps.say(`Chat command from ${line.username} failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private ourNames(): string[] {
    return [...listPersonas(this.state.root).map((persona) => persona.username), this.state.settings.commands.listenerName];
  }

  private async run(line: CommandLine, command: NonNullable<ReturnType<typeof parseChatCommand>>, answer: (text: string) => Promise<void>): Promise<void> {
    const summary = await runChatCommand(command, this.control, answer, this.state.settings.commands.prefix);
    this.deps.say(`Chat command from ${line.username}: ${summary}`);
  }

  private async refuse(line: CommandLine, answer: (text: string) => Promise<void>): Promise<void> {
    let outcome = "refused (not in commands.players)";
    try {
      await answer(REFUSAL_ANSWER);
    } catch (error) {
      outcome += `, answer failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.deps.say(`Chat command from ${line.username}: ${outcome}`);
  }

  // ---------- the answers ----------

  /** Whispers `text` to the player who typed the command, in lines the game accepts. Dropped, and only logged, once the stack is stopping. */
  private async answer(line: CommandLine, source: LineSource, text: string): Promise<void> {
    if (this.answersOff || (source.kind === "console" && this.state.server === null)) {
      this.dropAnswer(line, text);
      return;
    }
    for (const piece of toWhisperLines(text)) {
      if (!(await this.sendWhisper(line, source, piece))) return;
    }
  }

  /**
   * One piece of an answer. Console: a tellraw line. Otherwise `wayOut` picks the way; when there is none and the
   * listener is on its way in (our own stop just removed the last bot), the answer waits for it up to `answerWaitMs`.
   * False: the stack began stopping meanwhile and the piece was dropped (said, not sent). Throws when no way comes.
   */
  private async sendWhisper(line: CommandLine, source: LineSource, piece: string): Promise<boolean> {
    if (source.kind === "console") {
      this.writeTellraw(line, piece);
      return true;
    }
    const deadline = this.deps.now() + this.state.manifest.commands.answerWaitMs;
    for (;;) {
      if (this.answersOff) return this.dropAnswer(line, piece);
      const route = this.wayOut(line, source);
      if (route?.kind === "host") {
        await this.whisperThroughHost(route.poller, line.username, piece);
        return true;
      }
      if (route?.kind === "console") {
        this.writeTellraw(line, piece);
        return true;
      }
      if (route?.kind === "listener" && this.listener?.whisper(line.username, piece) === true) return true;
      const left = deadline - this.deps.now();
      if (this.listener?.isWanted() !== true || left <= 0) throw new Error(this.isRemote ? "no bot of ours and no listener is on the server to answer through" : "the local Minecraft server is not running, so there is no way to answer");
      await Promise.race([this.deps.sleep(Math.min(ANSWER_RETRY_MS, left)), this.stopped$]);
    }
  }

  private writeTellraw(line: CommandLine, piece: string): void {
    this.state.server?.stdin?.write(tellrawLine(line.username, piece));
  }

  private dropAnswer(line: CommandLine, text: string): false {
    this.deps.say(`Answer to ${line.username} not sent, Mine AI is stopping: ${text}`);
    return false;
  }

  /**
   * Where a piece goes now, or null. A whisper goes back where it was heard while that source is still in (its host is
   * polled, the listener is joined); a source that is gone falls back to the public way, which on a local server is the
   * console and on a remote one the reader host, else the joined listener.
   */
  private wayOut(line: CommandLine, source: LineSource): LineSource | { readonly kind: "console" } | null {
    if (line.channel === "whisper" && this.isSourceIn(source)) return source;
    if (!this.isRemote) return this.state.server === null ? null : { kind: "console" };
    const reader = this.reader();
    if (reader !== null) return { kind: "host", poller: reader };
    return this.listener?.isJoined() === true ? { kind: "listener" } : null;
  }

  private isSourceIn(source: LineSource): boolean {
    if (source.kind === "host") return this.isPolled(source.poller);
    return source.kind === "listener" && this.listener?.isJoined() === true;
  }

  /** A whisper is sent once: a host that drops mid-answer may still have sent it, and a second one would show twice. */
  private async whisperThroughHost(poller: HostPoller, to: string, message: string): Promise<void> {
    const response = await this.deps.fetch(`http://127.0.0.1:${poller.bot.hostPort}/chat-commands/whisper`, {
      method: "POST",
      headers: { "content-type": "application/json", [CONTROL_HEADER]: "1" },
      body: JSON.stringify({ to, message }),
      signal: AbortSignal.timeout(HOST_WHISPER_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || body.ok !== true) throw new Error(body.error ?? `${poller.bot.username}'s host answered HTTP ${response.status}`);
  }
}
