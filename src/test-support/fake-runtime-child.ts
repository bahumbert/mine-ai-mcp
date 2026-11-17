/** An in-process runtime fixture with real HTTP, measured process exits and explicit liveness messages. */
import { EventEmitter } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { ExecutionScope, observeExecution, type ExecutionEvent } from "../execution/execution-scope.js";
import { INCIDENT_HISTORY_MS } from "../diagnostics/incident-recorder.js";
import { monotonicNow } from "../utils/monotonic-clock.js";
import type { RuntimeActivity } from "../server/runtime-liveness.js";
import type { ProcessFault } from "../server/process-faults.js";
import type { RuntimeChild, SupervisorClock } from "../server/runtime-supervisor.js";

export interface FakeRuntimeChildOptions {
  readonly ignoreSigterm?: boolean;
  readonly pid?: number;
  readonly historyMs?: number;
  readonly pauseMs?: number;
  readonly slowMs?: number;
  /** Route delays share the supervisor's manual clock; a fixture user without a supervisor leaves this unset and waits real time. */
  readonly clock?: SupervisorClock;
}

/** The runtime fixture API; `ready` binds its port before publishing the ready message. */
export interface FakeRuntimeChild extends RuntimeChild {
  readonly port: number;
  readonly kills: string[];
  beat(activity?: RuntimeActivity): void;
  ready(): Promise<void>;
  fault(fault: ProcessFault): void;
  exit(code: number | null, signal: NodeJS.Signals | null): void;
  arrived(path: string): Promise<void>;
  close(): Promise<void>;
}

/** Keeps fixture route lifetimes and timer cleanup together, without blocking the test process. */
class FakeChild extends EventEmitter implements FakeRuntimeChild {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];
  readonly #server = createServer((request, response) => { void this.#route(request.url ?? "unknown", response); });
  readonly #arrivals = new Set<string>();
  readonly #waiting = new Map<string, Set<() => void>>();
  readonly #active = new Map<string, ExecutionEvent>();
  readonly #owners = new Set<ExecutionScope["owner"]>();
  readonly #releases = new Set<() => void>();
  readonly #timers = new Set<() => void>();
  readonly #removeObserver: () => void;
  #exited = false;
  #closing: Promise<void> | null = null;
  #sequence = 0;
  #events = 0;
  #precedingRequestId: number | null = null;
  #silent = false;
  #port = 0;

  constructor(readonly options: FakeRuntimeChildOptions) {
    super();
    this.pid = options.pid ?? 1;
    this.#removeObserver = observeExecution((event) => {
      if (!this.#owners.has(event.owner) || this.#exited) return;
      if (event.activePhase === null) this.#active.delete(event.scopeId);
      else this.#active.set(event.scopeId, event);
      if (event.kind === "closed" && event.owner.requestId != null) this.#precedingRequestId = event.owner.requestId;
      this.#events++;
      this.emit("message", { kind: "execution", event, activity: this.#activity() });
    });
  }

  get port(): number { return this.#port; }

  #activity(): RuntimeActivity {
    return { observedAt: Date.now(), active: [...this.#active.values()], precedingRequestId: this.#precedingRequestId };
  }

  beat(activity = this.#activity()): void {
    if (this.#exited || this.#silent) return;
    this.emit("message", { kind: "heartbeat", sequence: ++this.#sequence, executionEvents: this.#events, omitted: 0, memory: process.memoryUsage(), activity });
  }

  async ready(): Promise<void> {
    if (!this.#server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.#server.once("error", reject);
        this.#server.listen(0, "127.0.0.1", () => { this.#server.off("error", reject); resolve(); });
      });
      const address = this.#server.address();
      if (address && typeof address !== "string") this.#port = address.port;
    }
    if (!this.#exited) this.emit("message", { kind: "ready", port: this.#port });
  }

  fault(fault: ProcessFault): void {
    if (!this.#exited) this.emit("message", { kind: "fault", fault });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.#exited) return false;
    this.kills.push(signal);
    if (signal !== "SIGTERM" || !this.options.ignoreSigterm) setImmediate(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.#removeObserver();
    for (const cancel of this.#timers) cancel();
    this.#timers.clear();
    for (const release of this.#releases) release();
    this.#releases.clear();
    this.#server.closeAllConnections();
    this.#server.close();
    this.emit("exit", code, signal);
  }

  arrived(path: string): Promise<void> {
    if (this.#arrivals.delete(path)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiting = this.#waiting.get(path) ?? new Set();
      waiting.add(resolve);
      this.#waiting.set(path, waiting);
    });
  }

  close(): Promise<void> {
    return this.#closing ??= new Promise<void>((resolve) => {
      this.exit(0, null);
      this.#server.close(() => resolve());
    });
  }

  #wait(ms?: number): Promise<void> {
    if (this.#exited) return Promise.resolve();
    return new Promise((resolve) => {
      const release = () => { this.#releases.delete(release); resolve(); };
      this.#releases.add(release);
      if (ms !== undefined) {
        const fire = () => { this.#timers.delete(cancel); release(); };
        const cancel = this.options.clock?.after(ms, fire) ?? afterRealTime(ms, fire);
        this.#timers.add(cancel);
      }
    });
  }

  #scope(operation: string, requestId?: number): ExecutionScope {
    const owner = { bot: requestId === 812 && operation === "navigate" ? "FaultTest" : "WatchdogTest", operation, targetId: null,
      ...(requestId === undefined ? {} : { requestId, actionId: "fault-action-812" }) };
    this.#owners.add(owner);
    return new ExecutionScope(owner);
  }

  /** On an injected clock the delay is that clock's own timer; without one, wall-clock corrections must not stretch it. */
  async #waitForBackgroundDelay(ms: number): Promise<void> {
    if (this.options.clock) return this.#wait(ms);
    const end = monotonicNow() + ms;
    while (!this.#exited && monotonicNow() < end) await this.#wait(50);
  }

  async #route(path: string, response: ServerResponse): Promise<void> {
    // The arrival is observed after synchronous route effects, before the caller can advance its watchdog.
    const running = this.#answer(path, response);
    const waiting = this.#waiting.get(path);
    if (!waiting) this.#arrivals.add(path);
    for (const resolve of waiting ?? []) resolve();
    this.#waiting.delete(path);
    await running;
  }

  async #answer(path: string, response: ServerResponse): Promise<void> {
    if (path === "/background") return this.#background(response);
    if (path === "/health") { response.end('{"ok":true}'); return; }
    if (path === "/slow") { await this.#wait(this.options.slowMs ?? 6_000); response.end("finished"); return; }
    if (path === "/pause") {
      response.end("accepted");
      await this.#wait(100);
      this.#silent = true;
      await this.#wait(this.options.pauseMs ?? 7_000);
      this.#silent = false;
      return;
    }
    if (path === "/crash") { this.exit(23, null); return; }
    if (path === "/fault") this.#reportFault("raised while ready");
    if (path === "/fault-twice") { this.#reportFault("first distinct fault"); this.#reportFault("second distinct fault"); }
    if (path === "/fault-during-request") {
      // The fixture leaves this scope undisposed; a closed transition would invent a preceding request.
      const execution = this.#scope("navigate", 812);
      await execution.run("route", async () => {
        this.beat();
        this.#reportFault("raised during request 812");
      });
    }
    if (path.startsWith("/fault")) { response.end('{"ok":true}'); return; }
    if (path === "/sse-hang") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": ready\n\n"); }
    using execution = this.#scope("fault_injection");
    await execution.run(path, async () => { this.#silent = true; await this.#wait(); });
  }

  async #background(response: ServerResponse): Promise<void> {
    const owner = { bot: "WatchdogTest", operation: "navigate", targetId: null, requestId: 812, actionId: "background-action-812" };
    this.#owners.add(owner);
    using execution = new ExecutionScope(owner);
    await execution.run("route", async () => {
      await execution.run("brief_nested_phase", async () => {});
      response.end("accepted");
      await this.#waitForBackgroundDelay((this.options.historyMs ?? INCIDENT_HISTORY_MS) + 2_000);
      this.#silent = true;
      await this.#wait();
    });
  }

  #reportFault(message: string): void {
    this.fault({ kind: "unhandled_rejection", message, stack: `Error: ${message}\n    at faulting-runtime`, observedAt: new Date().toISOString(), repeats: 0 });
  }
}

/** Cancellable route delay for a fixture built without an injected clock. */
function afterRealTime(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}

/** Build a controllable child; blocked fixture loops become held HTTP requests. */
export function createFakeRuntimeChild(options: FakeRuntimeChildOptions = {}): FakeRuntimeChild {
  return new FakeChild(options);
}
