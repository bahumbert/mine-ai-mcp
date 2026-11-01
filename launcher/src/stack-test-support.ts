// Fakes for the stack tests: a scripted child runner, a routed fetch and a clock that moves only when asked to sleep.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Child, ChildExit, SpawnChildOptions, StopOptions, StopResult } from "./processes.ts";
import type { ProcessInfo } from "./process-list.ts";
import type { ProbeResult } from "./install/probe.ts";
import { loadManifest, type Manifest } from "./manifest.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { startStack, type ChildRunner, type StackDeps } from "./stack.ts";

/** What a fake child does once spawned. */
export interface ChildScript {
  /** Output lines delivered right after the spawn (the server's `Done (` line). */
  readonly lines?: readonly string[];
  /** The process ends at once with this code (a server that cannot bind its port). */
  readonly exitsWith?: number;
  /** The graceful step does not end it: `stop` kills it, as `Children.stop` does after `timeoutMs` (a server that hangs while saving). */
  readonly ignoresStop?: boolean;
  /** The exit code (default 0) or signal of a child that ends on its graceful step (a server that fails while saving). */
  readonly stopExitCode?: number;
  readonly stopSignal?: NodeJS.Signals;
}

export interface SpawnCall {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly options: SpawnChildOptions;
  readonly pid: number;
}

/** `events` is shared with the fake fetch so a test can assert the order of spawns, stops and requests. */
export class FakeChildren implements ChildRunner {
  readonly spawns: SpawnCall[] = [];
  readonly stdinText = new Map<string, string>();
  readonly stopOptions = new Map<string, StopOptions>();
  private readonly scripts = new Map<string, ChildScript>();
  private readonly running = new Map<string, (exit: ChildExit) => void>();
  private nextPid = 4000;

  constructor(readonly events: string[]) {}

  script(name: string, script: ChildScript): void {
    this.scripts.set(name, script);
  }

  pidOf(name: string): number {
    const call = this.spawns.find((entry) => entry.name === name);
    if (!call) throw new Error(`no child "${name}" was spawned`);
    return call.pid;
  }

  argsOf(name: string): readonly string[] {
    return this.spawns.filter((entry) => entry.name === name).at(-1)!.args;
  }

  optionsOf(name: string): SpawnChildOptions {
    return this.spawns.filter((entry) => entry.name === name).at(-1)!.options;
  }

  spawn(name: string, cmd: string, args: readonly string[], options: SpawnChildOptions): Child {
    if (this.running.has(name)) throw new Error(`Child "${name}" is already running`);
    const pid = this.nextPid++;
    this.events.push(`spawn ${name}`);
    this.spawns.push({ name, cmd, args, options, pid });
    const script = this.scripts.get(name) ?? {};
    const stdin = options.stdin === "pipe" ? new PassThrough() : null;
    stdin?.on("data", (chunk: Buffer) => this.stdinText.set(name, (this.stdinText.get(name) ?? "") + chunk.toString()));
    let alive = true;
    let finish: (exit: ChildExit) => void = () => {};
    const exited = new Promise<ChildExit>((resolve) => {
      finish = (exit) => {
        alive = false;
        this.running.delete(name);
        resolve(exit);
      };
    });
    this.running.set(name, finish);
    queueMicrotask(() => {
      for (const line of script.lines ?? []) options.onLine?.(line, "stdout");
      if (script.exitsWith !== undefined) finish({ code: script.exitsWith, signal: null });
    });
    return { name, pid, stdin, exited, isRunning: () => alive };
  }

  async stop(name: string, options: StopOptions): Promise<StopResult> {
    const finish = this.running.get(name);
    if (!finish) return "not-running";
    this.events.push(`stop ${name}`);
    this.stopOptions.set(name, options);
    await options.graceful?.();
    const script = this.scripts.get(name);
    const exit: ChildExit = script?.stopSignal ? { code: null, signal: script.stopSignal } : { code: script?.stopExitCode ?? 0, signal: null };
    finish(exit);
    // As `Children.stop`: with no graceful step the child is killed; with one, killed only when it ignores it.
    return options.graceful && !script?.ignoresStop ? { ended: exit } : "killed";
  }

  async stopAll(order: readonly string[], options: StopOptions = { timeoutMs: 10_000 }): Promise<void> {
    for (const name of [...order, ...[...this.running.keys()].filter((entry) => !order.includes(entry)).reverse()]) await this.stop(name, options);
  }

  /** The child ends by itself (a crash), as the exit event would report it. */
  crash(name: string, code: number): void {
    this.running.get(name)?.({ code, signal: null });
  }
}

export type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch answering by `METHOD url` (query ignored); an unrouted request is a connection refusal. */
export class FakeNetwork {
  readonly requests: { method: string; url: string; body: string }[] = [];
  private readonly routes = new Map<string, Route>();

  constructor(private readonly events: string[]) {}

  route(method: string, url: string, answer: Route): void {
    this.routes.set(`${method} ${url}`, answer);
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    this.requests.push({ method, url, body });
    this.events.push(`fetch ${method} ${new URL(url).pathname}`);
    const answer = this.routes.get(`${method} ${url}`);
    if (!answer) throw new TypeError(`fetch failed: ${url} refused`);
    return await answer(init);
  }) as typeof fetch;
}

export const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });

/** Time that passes only through `sleep`, so a 90 s wait costs no real time. */
export class FakeClock {
  time = 0;
  readonly now = (): number => this.time;
  readonly sleep = async (ms: number): Promise<void> => {
    this.time += ms;
    await Promise.resolve();
  };
}

export interface StackFixture {
  readonly root: string;
  readonly ollamaUrl: string;
  readonly manifest: Manifest;
  readonly settings: Settings;
  readonly events: string[];
  readonly children: FakeChildren;
  readonly network: FakeNetwork;
  readonly said: string[];
  readonly clock: FakeClock;
  readonly killed: number[];
  processes: ProcessInfo[];
  probe: ProbeResult;
  readonly deps: StackDeps;
}

const PERSONAS: Record<string, string> = { ayla: "Ayla", brea: "Brea", zed: "Zed" };

/** A data root with three persona files, the shipped manifest, and fakes wired as a running Windows PC would answer. */
export function stackFixture(change: (settings: Settings) => Settings = (settings) => settings): StackFixture {
  const root = mkdtempSync(join(tmpdir(), "mine-ai-stack-"));
  mkdirSync(join(root, "personas"), { recursive: true });
  for (const [id, username] of Object.entries(PERSONAS)) writeFileSync(join(root, "personas", `${id}.json`), JSON.stringify({ id, username }));
  const manifest = loadManifest();
  const settings = change({ ...loadSettings(root, manifest), server: { kind: "local", port: 25_565, memoryMb: 4096 } });
  const events: string[] = [];
  const children = new FakeChildren(events);
  const network = new FakeNetwork(events);
  const clock = new FakeClock();
  const ollamaUrl = `http://127.0.0.1:${manifest.ollama.port}`;
  children.script("server", { lines: ["[12:00:00] [Server thread/INFO]: Done (3.2s)! For help, type \"help\""] });
  const fixture: StackFixture = {
    root,
    ollamaUrl,
    manifest,
    settings,
    events,
    children,
    network,
    said: [],
    clock,
    killed: [],
    processes: [],
    probe: { up: true, versionOk: true, onlineMode: false, detail: "ok" },
    deps: undefined as unknown as StackDeps,
  };
  // The Ollama serve answers only once spawned, as the real one does.
  network.route("GET", `${ollamaUrl}/api/version`, () => (events.includes("spawn ollama") ? json({ version: "0.35.0" }) : Promise.reject(new TypeError("refused"))));
  network.route("POST", `${ollamaUrl}/api/generate`, () => json({ done: true }));
  const deps: StackDeps = {
    fetch: network.fetch,
    now: clock.now,
    sleep: clock.sleep,
    probeServer: async () => fixture.probe,
    ollamaExe: () => "C:/Ollama/ollama.exe",
    fileExists: () => true,
    settingsFileExists: () => true,
    freePort: async (start, taken = new Set<number>()) => {
      let port = start;
      while (taken.has(port)) port++;
      return port;
    },
    listProcesses: async () => fixture.processes,
    killProcess: (pid) => void fixture.killed.push(pid),
    bunPath: "C:/MineAI/bun.exe",
    appRoot: "C:/MineAI",
    say: (line) => void fixture.said.push(line),
    // The real sources poll for as long as the stack runs (`chat/sources.test.ts` covers them); here they are a recording stand-in.
    startChatCommands: () => {
      events.push("start chat commands");
      return { stop: async () => void events.push("stop chat commands") };
    },
  };
  return Object.assign(fixture, { deps });
}

/** Routes `/health` of a host port: answers 200 after `failures` refusals. */
export function hostHealth(fixture: StackFixture, port: number, failures = 0): void {
  let refused = 0;
  fixture.network.route("GET", `http://127.0.0.1:${port}/health`, () => (refused++ < failures ? json({}, 503) : json({ ok: true })));
}

/** A fixture whose stack is started: both first host ports answer healthy. */
export async function startedFixture(change?: Parameters<typeof stackFixture>[0]) {
  const fixture = stackFixture(change);
  hostHealth(fixture, 25_575);
  hostHealth(fixture, 25_576);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  return { fixture, state };
}
