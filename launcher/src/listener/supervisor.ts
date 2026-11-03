// Keeps the listener process joined while the launcher wants it: retries a lost connection with a growing pause, and
// gives up for good on a kick (spec 2026-10-30-in-game-bot-commands D4 "Listener connection rules").
import { z } from "zod";

/** The listener child as the supervisor sees it; `Children.spawn(...)` in `processes.ts` is adapted to this by the stack. */
export interface ListenerProcess {
  /** The child's stdout, one JSON object per line. */
  readonly lines: AsyncIterable<string>;
  /** Sends one complete line (it ends with a line break; a blank line is harmless to the child). */
  write(line: string): void;
  stop(): Promise<void>;
  readonly exited: Promise<unknown>;
}

/** A command line a player typed; the same shape as `CommandLine` in `launcher/src/chat/policy.ts` (this task starts before that file is merged). */
export interface ListenerCommand {
  readonly username: string;
  readonly channel: "chat" | "whisper";
  readonly message: string;
}

export interface ListenerSupervisorDeps {
  spawn(): ListenerProcess;
  now(): number;
  sleep(ms: number): Promise<void>;
  say(line: string): void;
  onCommand(line: ListenerCommand): void;
  /** The listener's username, for the console lines. */
  name: string;
  /** The first pause before a retry (it doubles up to 5 minutes); the launcher passes the manifest's `listenerAfterMs`. Default 5 s. */
  retryFirstMs?: number;
}

const DEFAULT_FIRST_RETRY_MS = 5_000;
const LAST_RETRY_MS = 300_000;
/**
 * A kick that no retry changes: the name is not whitelisted or is banned (vanilla's translation keys). Any other kick
 * (a server restart, an idle kick, a plugin's text) is a lost connection: commands must come back by themselves.
 */
const FINAL_KICK_KEY = /^multiplayer\.disconnect\.(?:not_whitelisted|banned)/u;

/** The JSON lines `listener.ts` writes to stdout. */
const listenerEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("joined") }),
  z.object({ kind: z.literal("command"), username: z.string(), channel: z.enum(["chat", "whisper"]), message: z.string() }),
  z.object({ kind: z.literal("ended"), reason: z.string(), duplicate: z.boolean(), kicked: z.boolean() }),
]);

function parseListenerEvent(line: string): z.infer<typeof listenerEventSchema> | null {
  try {
    const parsed = listenerEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The duplicate-login kick (the name is taken) and the whitelist and ban kicks: a retry cannot change them. */
function isFinalKick(ended: { readonly reason: string; readonly duplicate: boolean; readonly kicked: boolean }): boolean {
  return ended.duplicate || (ended.kicked && FINAL_KICK_KEY.test(ended.reason));
}

interface RunOutcome {
  readonly joined: boolean;
  /** The listener's own `ended` line; null when the process closed its stdout without one. */
  readonly ended: { readonly reason: string; readonly duplicate: boolean; readonly kicked: boolean } | null;
}

export class ListenerSupervisor {
  private wanted = false;
  /** A duplicate login, a whitelist or a ban stopped the retries: still wanted, but it will never join until the want is made again. */
  private givenUp = false;
  private stopped = false;
  /** Bumped on every change of want; a loop or a process from an older one does nothing more. A kick ends the loop, so a retry needs the want withdrawn and made again. */
  private generation = 0;
  private current: ListenerProcess | null = null;
  private joined = false;
  private leaving: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ListenerSupervisorDeps) {}

  /** Joins (true) or leaves (false) the server; idempotent. */
  setWanted(wanted: boolean): void {
    if (this.stopped || wanted === this.wanted) return;
    this.wanted = wanted;
    this.givenUp = false;
    this.generation += 1;
    if (wanted) {
      void this.keepJoined(this.generation);
      return;
    }
    void this.leave();
  }

  isJoined(): boolean {
    return this.joined;
  }

  /** True while it is wanted and a join (or a retry) can still come; false after a final kick (no retry) or `stop()`. */
  isWanted(): boolean {
    return this.wanted && !this.givenUp;
  }

  /** Sends a whisper through the listener; false when it is not on the server. */
  whisper(to: string, message: string): boolean {
    if (!this.joined || this.current === null) return false;
    this.current.write(`${JSON.stringify({ kind: "whisper", to, message })}\n`);
    return true;
  }

  /** Stack stop: leaves the server and never starts again. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wanted = false;
    this.generation += 1;
    await this.leave();
  }

  /** Drops the current process (if any) and stops it. `leaving` is that stop: a new process waits for it, since `Children.spawn` refuses a name that still runs. */
  private leave(): Promise<void> {
    const child = this.current;
    this.joined = false;
    this.current = null;
    if (child !== null) this.leaving = this.stopChild(child);
    return this.leaving;
  }

  private async stopChild(child: ListenerProcess): Promise<void> {
    try {
      await child.stop();
    } catch (error) {
      this.deps.say(`Could not stop the chat command listener: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.wanted && !this.stopped;
  }

  /** The join / retry loop of one want; it ends when the want changes, after a kick, or at stack stop. */
  private async keepJoined(generation: number): Promise<void> {
    const firstRetryMs = this.deps.retryFirstMs ?? DEFAULT_FIRST_RETRY_MS;
    let delayMs = firstRetryMs;
    let outageSaid = false;
    while (this.isCurrent(generation)) {
      const outcome = await this.runOnce(generation);
      if (!this.isCurrent(generation)) return;
      if (outcome.ended !== null && isFinalKick(outcome.ended)) {
        this.givenUp = true;
        this.deps.say(this.kickLine(outcome.ended));
        return;
      }
      if (outcome.joined) {
        delayMs = firstRetryMs;
        outageSaid = false;
      }
      if (!outageSaid) {
        outageSaid = true;
        const what = outcome.ended?.kicked === true ? "was kicked" : outcome.joined ? "lost the server" : "could not join";
        this.deps.say(`Chat command listener ${what} (${outcome.ended?.reason ?? "its process ended"}); retrying in ${delayMs / 1_000} s.`);
      }
      await this.deps.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, LAST_RETRY_MS);
    }
  }

  private kickLine(ended: { readonly reason: string; readonly duplicate: boolean }): string {
    return ended.duplicate
      ? `Another client is on this server as ${this.deps.name}: set another commands.listenerName in settings.json.`
      : `The server kicked the chat command listener (${this.deps.name}): ${ended.reason}. It does not retry by itself: ask the server owner to whitelist or unban ${this.deps.name}, or set another commands.listenerName in settings.json.`;
  }

  /** One process from spawn to the end of its stdout; a spawn that throws counts as a connection that failed. */
  private async runOnce(generation: number): Promise<RunOutcome> {
    await this.leaving;
    if (!this.isCurrent(generation)) return { joined: false, ended: null };
    let child: ListenerProcess;
    try {
      child = this.deps.spawn();
    } catch (error) {
      return { joined: false, ended: { reason: error instanceof Error ? error.message : String(error), duplicate: false, kicked: false } };
    }
    this.current = child;
    let joined = false;
    let ended: RunOutcome["ended"] = null;
    for await (const line of child.lines) {
      if (!this.isCurrent(generation)) break;
      const event = parseListenerEvent(line);
      if (event === null) continue;
      if (event.kind === "joined") {
        joined = true;
        this.joined = true;
        this.deps.say(`Listening for chat commands as ${this.deps.name}.`);
      } else if (event.kind === "command") {
        this.handleCommand({ username: event.username, channel: event.channel, message: event.message });
      } else {
        ended = event;
        break;
      }
    }
    // A child `leave()` already took is being stopped there; stopping it again from this stale tail could hit its successor.
    if (this.current === child) {
      this.current = null;
      this.joined = false;
      await this.stopChild(child);
    }
    return { joined, ended };
  }

  /** The handler is the launcher's: a bug in it is said, and the listener keeps serving. */
  private handleCommand(line: ListenerCommand): void {
    try {
      this.deps.onCommand(line);
    } catch (error) {
      this.deps.say(`Chat command from ${line.username} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
