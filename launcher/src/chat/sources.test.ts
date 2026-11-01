import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import test from "node:test";
import type { ListenerProcess } from "../listener/supervisor.ts";
import { hostHealth, json, stackFixture } from "../stack-test-support.ts";
import { startBot, startStack } from "../stack.ts";
import { startChatCommands } from "./sources.ts";

const START_TIME = 1_800_000_000_000;
const HOST_PORT_BASE = 25_575;

/** Time that moves only when a test says so; a sleeping loop wakes when its time has come. */
class ManualClock {
  time = START_TIME;
  private readonly sleeping: { at: number; wake(): void }[] = [];
  readonly now = (): number => this.time;
  readonly sleep = (ms: number): Promise<void> => new Promise((resolve) => this.sleeping.push({ at: this.time + ms, wake: resolve }));

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const next = this.sleeping.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.sleeping.splice(this.sleeping.indexOf(next), 1);
      this.time = Math.max(this.time, next.at);
      next.wake();
      await settle();
    }
    this.time = target;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface HeardLine {
  seq: number;
  username: string;
  channel: "chat" | "whisper";
  message: string;
  at: string;
}

/** The command ring of one host as `src/server/chat-commands-route.ts` serves it. */
class FakeHost {
  epoch = "epoch-1";
  status = 200;
  hangs = false;
  /** While set, an answer waits for it: a request in flight when the test acts. */
  gate: Promise<void> | null = null;
  whisperFails = false;
  readonly lines: HeardLine[] = [];
  readonly whispers: { to: string; message: string }[] = [];
  private seq = 0;

  constructor(private readonly clock: ManualClock) {}

  hear(username: string, channel: "chat" | "whisper", message: string, at = this.clock.time): void {
    this.seq += 1;
    this.lines.push({ seq: this.seq, username, channel, message, at: new Date(at).toISOString() });
  }

  restart(): void {
    this.epoch = `epoch-${Number(this.epoch.slice(6)) + 1}`;
    this.lines.length = 0;
    this.seq = 0;
  }

  answer(url: URL, init: RequestInit | undefined): Response | Promise<Response> {
    if (this.gate !== null) return this.gate.then(() => this.answerNow(url, init));
    return this.answerNow(url, init);
  }

  private answerNow(url: URL, init: RequestInit | undefined): Response | Promise<Response> {
    if (this.hangs) return new Promise<Response>(() => {});
    if (this.status !== 200) return json({ ok: false, error: "runtime failed" }, this.status);
    if (init?.method === "POST") {
      if (this.whisperFails) return json({ ok: false, error: "no echo" }, 502);
      this.whispers.push(JSON.parse(String(init.body)) as { to: string; message: string });
      return json({ ok: true });
    }
    const after = Number(url.searchParams.get("after") ?? 0);
    return json({ epoch: this.epoch, lastSeq: this.seq, commands: this.lines.filter((line) => line.seq > after) });
  }
}

/** A listener process whose stdout the test writes to and whose stdin it reads. */
class FakeListenerProcess implements ListenerProcess {
  readonly stdout = new PassThrough();
  readonly stdin: string[] = [];
  readonly lines: AsyncIterable<string> = createInterface({ input: this.stdout });
  readonly exited: Promise<unknown>;
  stopped = false;
  private finish: () => void = () => {};

  constructor() {
    this.exited = new Promise<void>((resolve) => (this.finish = resolve));
  }

  write(line: string): void {
    this.stdin.push(line);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stdout.end();
    this.finish();
  }

  send(event: object): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

interface Options {
  server?: "local" | "remote";
  players?: string[];
  bots?: string[];
  serverIp?: string | null;
  enabled?: boolean;
  prefix?: string;
  /** The gate's per-sender cooldown; a test that proves another rule (one reader, one run) sets 0 so the cooldown cannot hide a breach of it. */
  cooldownMs?: number;
}

async function harness(options: Options = {}) {
  const server = options.server ?? "remote";
  const bots = options.bots ?? [];
  const fixture = stackFixture((settings) => ({
    ...settings,
    bots: [],
    server: server === "local" ? settings.server : { kind: "remote", host: "far.example", port: 25_565 },
    commands: { ...settings.commands, enabled: options.enabled ?? true, players: options.players ?? ["Tom"], prefix: options.prefix ?? "!" },
  }));
  if (options.serverIp !== null) {
    mkdirSync(join(fixture.root, "server"), { recursive: true });
    writeFileSync(join(fixture.root, "server", "server.properties"), `motd=x\nserver-ip=${options.serverIp ?? "127.0.0.1"}\nserver-port=25565\n`);
  }
  const clock = new ManualClock();
  const hosts = new Map<number, FakeHost>();
  const requests: { port: number; method: string; path: string; header: string | null }[] = [];
  bots.forEach((_, index) => hostHealth(fixture, HOST_PORT_BASE + index));
  const manifest = options.cooldownMs === undefined ? fixture.manifest : { ...fixture.manifest, commands: { ...fixture.manifest.commands, cooldownMs: options.cooldownMs } };
  const state = await startStack(fixture.settings, manifest, fixture.children, fixture.root, fixture.deps);
  for (const [index, id] of bots.entries()) {
    assert.equal((await startBot(state, id)).ok, true);
    hosts.set(HOST_PORT_BASE + index, new FakeHost(clock));
  }
  const processes: FakeListenerProcess[] = [];
  const fetchHost = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const host = hosts.get(Number(url.port));
    if (!host) throw new TypeError(`fetch failed: ${url.href} refused`);
    requests.push({ port: Number(url.port), method: init?.method ?? "GET", path: url.pathname + url.search, header: new Headers(init?.headers).get("x-mine-ai-control") });
    return await host.answer(url, init);
  }) as typeof fetch;
  const commands = startChatCommands(state, {
    fetch: fetchHost,
    now: clock.now,
    sleep: clock.sleep,
    say: (line) => void fixture.said.push(line),
    spawnListener: () => {
      const process = new FakeListenerProcess();
      processes.push(process);
      return process;
    },
  });
  await settle();
  const host = (index: number): FakeHost => hosts.get(HOST_PORT_BASE + index)!;
  const consoleLine = (name: string, text: string): void => state.onServerLine?.(`[17:13:28] [Server thread/INFO]: [Not Secure] <${name}> ${text}`);
  const serverInput = (): string => fixture.children.stdinText.get("server") ?? "";
  const commandSays = (): string[] => fixture.said.filter((line) => line.startsWith("Chat command from"));
  return { fixture, state, clock, hosts, host, requests, commands, processes, consoleLine, serverInput, commandSays };
}

const POLL_MS = 1_000;
test("public line heard by three hosts runs once, answered by the reader host only", async () => {
  const h = await harness({ bots: ["ayla", "brea", "zed"], cooldownMs: 0 });
  for (const index of [0, 1, 2]) h.host(index).hear("Tom", "chat", "!bots");
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 1);
  assert.equal(h.host(1).whispers.length + h.host(2).whispers.length, 0);
  assert.equal(h.host(0).whispers.length, 1);
  assert.equal(h.host(0).whispers[0]!.to, "Tom");
  assert.equal(h.host(0).whispers[0]!.message, "All bots are playing.");
});

test("host requests carry the control header and the cursor", async () => {
  const h = await harness({ bots: ["ayla"] });
  h.host(0).hear("Tom", "chat", "!bots");
  await h.clock.advance(POLL_MS);
  await h.clock.advance(POLL_MS);
  const polls = h.requests.filter((request) => request.method === "GET");
  assert.ok(polls.every((request) => request.header === "1"));
  assert.equal(polls[0]!.path, "/chat-commands?after=0");
  assert.equal(polls.at(-1)!.path, "/chat-commands?after=1");
});

test("a whisper heard by a non-reader host runs and is answered on that host", async () => {
  const h = await harness({ bots: ["ayla", "brea"] });
  h.host(1).hear("Tom", "whisper", "!bots");
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 1);
  assert.equal(h.host(1).whispers.length, 1);
  assert.equal(h.host(1).whispers[0]!.to, "Tom");
  assert.equal(h.host(0).whispers.length, 0);
});

test("when the reader stops the next oldest host reads", async () => {
  const h = await harness({ bots: ["ayla", "brea"] });
  await h.clock.advance(POLL_MS);
  h.state.bots.get("ayla")!.status = "ended";
  await h.clock.advance(POLL_MS);
  h.host(1).hear("Tom", "chat", "!bots");
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 1);
  assert.equal(h.host(1).whispers.length, 1);
});

test("reader answering 503 -> next host reads", async () => {
  const h = await harness({ bots: ["ayla", "brea"] });
  await h.clock.advance(POLL_MS);
  h.host(0).status = 503;
  await h.clock.advance(4 * POLL_MS);
  h.host(1).hear("Tom", "chat", "!bots");
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 1);
  assert.equal(h.host(1).whispers.length, 1);
  assert.equal(h.host(0).whispers.length, 0);
});

test("a line the next reader ran is not run again when the old reader comes back", async () => {
  const h = await harness({ bots: ["ayla", "brea"], cooldownMs: 0 });
  await h.clock.advance(POLL_MS);
  h.host(0).status = 503;
  await h.clock.advance(4 * POLL_MS);
  // Both hosts heard it a few ms apart (each stamps its own clock).
  h.host(0).hear("Tom", "chat", "!bots", h.clock.time);
  h.host(1).hear("Tom", "chat", "!bots", h.clock.time + 3);
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 1);
  h.host(0).status = 200;
  await h.clock.advance(2 * POLL_MS);
  assert.equal(h.commandSays().length, 1, "the old reader's copy of the same line is the same command");
});

test("the same words typed again later are a new command", async () => {
  const h = await harness({ bots: ["ayla"], cooldownMs: 0 });
  h.host(0).hear("Tom", "chat", "!bots");
  await h.clock.advance(POLL_MS);
  h.clock.time += 5_000;
  h.host(0).hear("Tom", "chat", "!bots");
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 2);
});

test("a poll that returns after stop() runs nothing and answers nothing", async () => {
  const h = await harness({ bots: ["ayla"] });
  await h.clock.advance(POLL_MS);
  let release: () => void = () => {};
  h.host(0).gate = new Promise<void>((resolve) => (release = resolve));
  h.host(0).hear("Tom", "whisper", "!bots");
  await h.clock.advance(POLL_MS);
  await h.commands.stop();
  release();
  await settle();
  assert.equal(h.commandSays().length, 0);
  assert.equal(h.host(0).whispers.length, 0);
});

test("a hung host does not stall the others", async () => {
  const h = await harness({ bots: ["ayla", "brea"] });
  h.host(0).hangs = true;
  h.host(1).hear("Tom", "whisper", "!bots");
  await h.clock.advance(POLL_MS);
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 1);
  assert.equal(h.host(1).whispers.length, 1);
});

test("a 90 s start does not drop a stop typed meanwhile", async () => {
  const h = await harness({ bots: ["ayla"] });
  let releaseHealth: () => void = () => {};
  const held = new Promise<void>((resolve) => (releaseHealth = resolve));
  h.fixture.network.route("GET", `http://127.0.0.1:${HOST_PORT_BASE + 1}/health`, async () => {
    await held;
    return json({ ok: true });
  });
  h.hosts.set(HOST_PORT_BASE + 1, new FakeHost(h.clock));
  h.host(0).hear("Tom", "whisper", "!bot start brea");
  await h.clock.advance(POLL_MS);
  assert.equal(h.state.bots.get("brea")?.status, "starting");
  h.clock.time += 2_500;
  h.host(0).hear("Tom", "whisper", "!bot stop ayla");
  await h.clock.advance(POLL_MS);
  assert.equal(h.state.bots.has("ayla"), false, "the stop ran while the start was still waiting");
  assert.equal(h.state.bots.get("brea")?.status, "starting");
  releaseHealth();
  await settle();
  assert.equal(h.state.bots.get("brea")?.status, "running");
});

test("a new epoch restarts the cursor and its lines from seq 1 are taken", async () => {
  const h = await harness({ bots: ["ayla"] });
  h.host(0).hear("Tom", "whisper", "!bots");
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 1);
  h.host(0).restart();
  h.clock.time += 3_000;
  h.host(0).hear("Ann", "whisper", "!bots");
  h.state.settings.commands.players.push("Ann");
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 2, "line seq 1 of the new epoch ran");
  assert.deepEqual(h.host(0).whispers.map((whisper) => whisper.to), ["Tom", "Ann"]);
});

test("a line 61 s old at receipt is dropped, one 59 s old runs", async () => {
  const h = await harness({ bots: ["ayla"] });
  h.host(0).hear("Tom", "whisper", "!bots", h.clock.time - 61_000);
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 0);
  h.clock.time += 3_000;
  h.host(0).hear("Tom", "whisper", "!bots", h.clock.time - 59_000);
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 1);
});

test("a local console line gets one tellraw on the server's stdin", async () => {
  const h = await harness({ server: "local" });
  h.consoleLine("Tom", "!bots");
  await settle();
  const written = h.serverInput();
  assert.equal(written.split("\n").filter((line) => line !== "").length, 1);
  assert.match(written, /^tellraw Tom \{"text":".*"\}\n$/u);
  assert.equal(h.commandSays().length, 1);
});

test("a local server's host chat lines are not the public source: the console is", async () => {
  const h = await harness({ server: "local", bots: ["ayla"] });
  h.host(0).hear("Tom", "chat", "!bots");
  await h.clock.advance(POLL_MS);
  assert.equal(h.commandSays().length, 0);
  assert.equal(h.host(0).whispers.length, 0);
});

test("a console line that is not a command, or is a faked sender, runs nothing", async () => {
  const h = await harness({ server: "local" });
  h.consoleLine("Tom", "hello !bots");
  h.consoleLine("Tom", "<Owner> !bots");
  h.state.onServerLine?.("[17:13:28] [Server thread/INFO]: [Server] !bots");
  await settle();
  assert.equal(h.commandSays().length, 0);
  assert.equal(h.serverInput(), "");
});

test("an answer after stop() is dropped: the start outcome arrives, nothing is written", async () => {
  const h = await harness({ server: "local" });
  let releaseHealth: () => void = () => {};
  const held = new Promise<void>((resolve) => (releaseHealth = resolve));
  hostHealth(h.fixture, HOST_PORT_BASE);
  h.fixture.network.route("GET", `http://127.0.0.1:${HOST_PORT_BASE}/health`, async () => {
    await held;
    return json({ ok: true });
  });
  h.consoleLine("Tom", "!bot start ayla");
  await settle();
  const writtenBeforeStop = h.serverInput();
  assert.match(writtenBeforeStop, /Starting Ayla/u);
  await h.commands.stop();
  h.state.server = null;
  releaseHealth();
  await settle();
  assert.equal(h.serverInput(), writtenBeforeStop, "no answer after stop");
  assert.ok(h.fixture.said.some((line) => /Ayla is running/u.test(line)), "the outcome is only logged");
});

test("server-ip 0.0.0.0: a stranger is refused, a listed player still runs, and the console says why", async () => {
  const h = await harness({ server: "local", serverIp: "0.0.0.0", players: ["Tom"] });
  assert.ok(h.fixture.said.some((line) => /commands\.players/u.test(line) && /127\.0\.0\.1/u.test(line)));
  h.consoleLine("Mallory", "!bot start ayla");
  await settle();
  assert.match(h.serverInput(), /tellraw Mallory/u);
  assert.equal(h.state.bots.size, 0);
  h.consoleLine("Tom", "!bots");
  await settle();
  assert.match(h.serverInput(), /tellraw Tom/u);
});

test("a local server with no server.properties gets the remote rules", async () => {
  const h = await harness({ server: "local", serverIp: null, players: [] });
  h.consoleLine("Tom", "!bots");
  await settle();
  assert.equal(h.state.bots.size, 0);
  assert.match(h.serverInput(), /^tellraw Tom /u);
  assert.ok(!h.commandSays().some((line) => line.includes("->")), "a refusal runs no command");
});

test("a bot's own name in chat runs nothing, and a cooldown ignores a second command", async () => {
  const h = await harness({ server: "local" });
  h.consoleLine("Ayla", "!bots");
  await settle();
  assert.equal(h.serverInput(), "");
  h.consoleLine("Tom", "!bots");
  h.consoleLine("Tom", "!bots");
  await settle();
  assert.equal(h.serverInput().split("\n").filter((line) => line !== "").length, 1);
});

test("an answer that a host cannot send is reported once and never sent again", async () => {
  const h = await harness({ bots: ["ayla"] });
  h.host(0).whisperFails = true;
  h.host(0).hear("Tom", "whisper", "!bots");
  await h.clock.advance(POLL_MS);
  await h.clock.advance(5 * POLL_MS);
  assert.equal(h.requests.filter((request) => request.method === "POST").length, 1);
  assert.match(h.commandSays()[0]!, /answer failed.*no echo/u);
});

test("the listener is wanted on a remote server with players and no bot, and gone once a host answers", async () => {
  const h = await harness({ bots: [] });
  await h.clock.advance(POLL_MS);
  assert.equal(h.processes.length, 0, "not before listenerAfterMs has passed with no host: a bot may be starting");
  await h.clock.advance(h.fixture.manifest.commands.listenerAfterMs);
  assert.equal(h.processes.length, 1);
  const [listener] = h.processes;
  assert.ok(listener);
  listener.send({ kind: "joined" });
  await h.clock.advance(POLL_MS);
  assert.equal(h.state.listenerJoined, "MineAI");
  assert.deepEqual((JSON.parse(readFileSync(join(h.fixture.root, "run", "other-agents.json"), "utf8")) as { usernames: string[] }).usernames, ["MineAI"]);
  hostHealth(h.fixture, HOST_PORT_BASE);
  h.hosts.set(HOST_PORT_BASE, new FakeHost(h.clock));
  assert.equal((await startBot(h.state, "ayla")).ok, true);
  await h.clock.advance(2 * POLL_MS);
  assert.equal(listener.stopped, true, "a host answers a poll: the listener leaves");
  assert.equal(h.state.listenerJoined, null);
  assert.deepEqual((JSON.parse(readFileSync(join(h.fixture.root, "run", "other-agents.json"), "utf8")) as { usernames: string[] }).usernames, ["Ayla"]);
});

test("the listener is wanted again after the last host stops", async () => {
  const h = await harness({ bots: ["ayla"] });
  await h.clock.advance(POLL_MS);
  assert.equal(h.processes.length, 0);
  h.state.bots.get("ayla")!.status = "ended";
  await h.clock.advance(h.fixture.manifest.commands.listenerAfterMs + 2 * POLL_MS);
  assert.equal(h.processes.length, 1);
});

test("only host 503 -> listener wanted after listenerAfterMs", async () => {
  const h = await harness({ bots: ["ayla"] });
  await h.clock.advance(POLL_MS);
  h.host(0).status = 503;
  await h.clock.advance(h.fixture.manifest.commands.listenerAfterMs - 2 * POLL_MS);
  assert.equal(h.processes.length, 0);
  await h.clock.advance(4 * POLL_MS);
  assert.equal(h.processes.length, 1);
});

test("remote with empty players: the listener is never wanted", async () => {
  const h = await harness({ bots: [], players: [] });
  await h.clock.advance(60_000);
  assert.equal(h.processes.length, 0);
});

test("a local server never wants the listener", async () => {
  const h = await harness({ server: "local" });
  await h.clock.advance(60_000);
  assert.equal(h.processes.length, 0);
});

test("a command from the listener runs and its answer is whispered through the listener", async () => {
  const h = await harness({ bots: [] });
  await h.clock.advance(h.fixture.manifest.commands.listenerAfterMs);
  const [listener] = h.processes;
  assert.ok(listener);
  listener.send({ kind: "joined" });
  listener.send({ kind: "command", username: "Tom", channel: "chat", message: "!bots" });
  await settle();
  assert.equal(listener.stdin.length, 1);
  const request = JSON.parse(listener.stdin[0]!) as { kind: string; to: string; message: string };
  assert.equal(request.kind, "whisper");
  assert.equal(request.to, "Tom");
  assert.ok(listener.stdin[0]!.endsWith("\n"));
  assert.equal(h.commandSays().length, 1);
});

test("commands.enabled false starts no source: no request, no listener, no console tap", async () => {
  const h = await harness({ bots: ["ayla"], enabled: false });
  h.host(0).hear("Tom", "whisper", "!bots");
  await h.clock.advance(60_000);
  assert.equal(h.requests.length, 0);
  assert.equal(h.processes.length, 0);
  assert.equal(h.state.onServerLine, undefined);
});

test("stop() ends the loops and the listener, and nothing is polled afterwards", async () => {
  const h = await harness({ bots: [] });
  await h.clock.advance(h.fixture.manifest.commands.listenerAfterMs);
  const [listener] = h.processes;
  assert.ok(listener);
  await h.commands.stop();
  assert.equal(listener.stopped, true);
  const before = h.requests.length;
  await h.clock.advance(60_000);
  assert.equal(h.processes.length, 1, "no respawn");
  assert.equal(h.requests.length, before);
  assert.equal(h.state.onServerLine, undefined);
});

// ---------- the last answer of a stop (run L finding F1) ----------

/** What a listener process was asked to whisper: its stdin lines, parsed. */
const listenerWhispers = (listener: FakeListenerProcess): { to: string; message: string }[] =>
  listener.stdin.map((line) => JSON.parse(line) as { to: string; message: string });

/** Brea the only bot of a remote server; Tom's stop line is heard by her own host. */
async function stopOnlyBot(channel: "chat" | "whisper") {
  const h = await harness({ bots: ["brea"], cooldownMs: 0 });
  await h.clock.advance(POLL_MS);
  h.host(0).hear("Tom", channel, "!bot stop brea");
  await h.clock.advance(POLL_MS);
  return h;
}

test("a chat stop of the last bot calls the listener in at once and its last answer goes through it", async () => {
  const h = await stopOnlyBot("chat");
  assert.equal(h.processes.length, 1, "wanted in the same tick the stop resolved, not listenerAfterMs later");
  assert.deepEqual(h.host(0).whispers.map((whisper) => whisper.message), ["Stopping Brea..."]);
  await h.clock.advance(3_000);
  h.processes[0]!.send({ kind: "joined" });
  await h.clock.advance(500);
  assert.deepEqual(listenerWhispers(h.processes[0]!).map((whisper) => [whisper.to, whisper.message]), [["Tom", "Brea stopped."]]);
  assert.equal(h.commandSays().length, 1);
  assert.doesNotMatch(h.commandSays()[0]!, /answer failed/u);
});

test("a remote /msg Brea !bot stop brea, Brea the only bot: the last answer is held and sent through the listener once it joins", async () => {
  const h = await stopOnlyBot("whisper");
  assert.equal(h.processes.length, 1);
  assert.deepEqual(h.host(0).whispers.map((whisper) => whisper.message), ["Stopping Brea..."], "the first answer went where the whisper was heard");
  assert.equal(listenerWhispers(h.processes[0]!).length, 0, "held until the listener is in");
  h.processes[0]!.send({ kind: "joined" });
  await h.clock.advance(500);
  assert.deepEqual(listenerWhispers(h.processes[0]!).map((whisper) => [whisper.to, whisper.message]), [["Tom", "Brea stopped."]]);
});

test("an answer with no way out fails after answerWaitMs", async () => {
  const h = await stopOnlyBot("chat");
  const { answerWaitMs } = h.fixture.manifest.commands;
  await h.clock.advance(answerWaitMs - 500);
  assert.equal(h.commandSays().length, 0, "still waiting");
  await h.clock.advance(1_000);
  assert.equal(h.commandSays().length, 1);
  assert.match(h.commandSays()[0]!, /answer failed: no bot of ours and no listener/u);
  assert.equal(listenerWhispers(h.processes[0]!).length, 0);
});

test("stop() during the wait drops the answer", async () => {
  const h = await stopOnlyBot("chat");
  h.processes[0]!.send({ kind: "joined" });
  await h.commands.stop();
  await settle();
  assert.ok(h.fixture.said.some((line) => /Answer to Tom not sent, Mine AI is stopping: Brea stopped\./u.test(line)));
  assert.equal(listenerWhispers(h.processes[0]!).length, 0);
});

test("stopping one of two bots keeps the listener out and answers through the other host", async () => {
  const h = await harness({ bots: ["ayla", "brea"], cooldownMs: 0 });
  await h.clock.advance(POLL_MS);
  h.host(0).hear("Tom", "chat", "!bot stop brea");
  await h.clock.advance(POLL_MS);
  assert.deepEqual(h.host(0).whispers.map((whisper) => whisper.message), ["Stopping Brea...", "Brea stopped."]);
  await h.clock.advance(2 * POLL_MS);
  assert.equal(h.processes.length, 0);
});

test("a whisper heard by the stopped bot is answered through the reader host", async () => {
  const h = await harness({ bots: ["ayla", "brea"], cooldownMs: 0 });
  await h.clock.advance(POLL_MS);
  h.host(1).hear("Tom", "whisper", "!bot stop brea");
  await h.clock.advance(POLL_MS);
  assert.deepEqual(h.host(1).whispers.map((whisper) => whisper.message), ["Stopping Brea..."]);
  assert.deepEqual(h.host(0).whispers.map((whisper) => whisper.message), ["Brea stopped."]);
});

test("on a local server a whisper heard by the stopped bot is answered by tellraw", async () => {
  const h = await harness({ server: "local", bots: ["ayla"], cooldownMs: 0 });
  await h.clock.advance(POLL_MS);
  h.host(0).hear("Tom", "whisper", "!bot stop ayla");
  await h.clock.advance(POLL_MS);
  assert.deepEqual(h.host(0).whispers.map((whisper) => whisper.message), ["Stopping Ayla..."]);
  assert.match(h.serverInput(), /^tellraw Tom \{"text":"Ayla stopped\."\}\n$/u);
  assert.doesNotMatch(h.commandSays()[0]!, /answer failed/u);
});

test("a whisper heard by the listener is answered through the reader host after the listener left", async () => {
  const h = await harness({ bots: ["ayla"], cooldownMs: 0 });
  await h.clock.advance(POLL_MS);
  h.host(0).status = 503;
  await h.clock.advance(h.fixture.manifest.commands.listenerAfterMs + 2 * POLL_MS);
  const [listener] = h.processes;
  assert.ok(listener);
  listener.send({ kind: "joined" });
  let releaseHealth: () => void = () => {};
  const held = new Promise<void>((resolve) => (releaseHealth = resolve));
  h.fixture.network.route("GET", `http://127.0.0.1:${HOST_PORT_BASE + 1}/health`, async () => {
    await held;
    return json({ ok: true });
  });
  h.hosts.set(HOST_PORT_BASE + 1, new FakeHost(h.clock));
  listener.send({ kind: "command", username: "Tom", channel: "whisper", message: "!bot start brea" });
  await settle();
  h.host(0).status = 200;
  await h.clock.advance(2 * POLL_MS);
  assert.equal(listener.stopped, true, "a host answers again: the listener left");
  releaseHealth();
  await h.clock.advance(500);
  assert.deepEqual(listenerWhispers(listener).map((whisper) => whisper.message), ["Starting Brea..."]);
  assert.match(h.host(0).whispers.map((whisper) => whisper.message).join("\n"), /^Brea is running/u);
});

test("a chat stop that throws on the only bot still calls the listener in and the failure answer goes through it", async () => {
  const h = await harness({ bots: ["brea"], cooldownMs: 0 });
  await h.clock.advance(POLL_MS);
  const stop = h.fixture.children.stop.bind(h.fixture.children);
  h.fixture.children.stop = async (name, options) => {
    if (name === "brain-brea") throw new Error("brain would not end");
    return await stop(name, options);
  };
  h.host(0).hear("Tom", "chat", "!bot stop brea");
  await h.clock.advance(POLL_MS);
  assert.equal(h.processes.length, 1, "the bot is stuck stopping and no longer a host: the listener is called in");
  h.processes[0]!.send({ kind: "joined" });
  await h.clock.advance(500);
  assert.deepEqual(listenerWhispers(h.processes[0]!).map((whisper) => [whisper.to, whisper.message]), [["Tom", "Could not stop Brea: brain would not end"]]);
  assert.doesNotMatch(h.commandSays()[0]!, /answer failed/u);
});

test("a host coming up during the wait carries the held answer, and the listener is no longer wanted", async () => {
  const h = await stopOnlyBot("chat");
  await h.clock.advance(2_000);
  const newHost = new FakeHost(h.clock);
  h.hosts.set(HOST_PORT_BASE, newHost);
  hostHealth(h.fixture, HOST_PORT_BASE);
  assert.equal((await startBot(h.state, "ayla")).ok, true);
  await h.clock.advance(2 * POLL_MS);
  assert.deepEqual(newHost.whispers.map((whisper) => whisper.message), ["Brea stopped."]);
  assert.equal(listenerWhispers(h.processes[0]!).length, 0);
  assert.equal(h.processes[0]!.stopped, true, "a host polls OK: the listener left");
});

test("a duplicate kick during the wait fails the answer at once", async () => {
  const h = await stopOnlyBot("chat");
  h.processes[0]!.send({ kind: "ended", reason: "multiplayer.disconnect.duplicate_login", duplicate: true, kicked: true });
  await h.clock.advance(500);
  assert.equal(h.commandSays().length, 1);
  assert.match(h.commandSays()[0]!, /answer failed/u);
});

test("two commands holding answers are both sent once the listener joins, each to its own sender", async () => {
  const h = await harness({ bots: ["brea"], players: ["Tom", "Ann"], cooldownMs: 0 });
  await h.clock.advance(POLL_MS);
  h.host(0).hear("Tom", "chat", "!bot stop brea");
  h.host(0).hear("Ann", "whisper", "!bot stop brea");
  await h.clock.advance(POLL_MS);
  assert.equal(h.processes.length, 1);
  assert.equal(listenerWhispers(h.processes[0]!).length, 0);
  h.processes[0]!.send({ kind: "joined" });
  await h.clock.advance(500);
  const sent = listenerWhispers(h.processes[0]!);
  assert.deepEqual(sent.map((whisper) => whisper.to).sort(), ["Ann", "Tom"]);
  assert.deepEqual(sent.map((whisper) => whisper.message).sort(), ["Brea is already stopping.", "Brea stopped."]);
});

test("a poll of a host we stopped, still in flight, does not keep the listener out", async () => {
  const h = await harness({ bots: ["ayla", "brea"], cooldownMs: 0 });
  await h.clock.advance(POLL_MS);
  let releasePoll: () => void = () => {};
  h.host(1).gate = new Promise<void>((resolve) => (releasePoll = resolve));
  await h.clock.advance(POLL_MS);
  h.host(0).hear("Tom", "whisper", "!bot stop brea");
  await h.clock.advance(POLL_MS);
  assert.equal(h.state.bots.has("brea"), false);
  h.host(0).hear("Tom", "whisper", "!bot stop ayla");
  await h.clock.advance(POLL_MS);
  assert.equal(h.processes.length, 1, "no host left: the listener is called in");
  releasePoll();
  await h.clock.advance(3 * POLL_MS);
  assert.equal(h.processes[0]!.stopped, false);
});
