// The launcher's local control endpoint (127.0.0.1) and the lock file that tells a second launcher or a console it exists.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { freePort } from "./ports.ts";
import type { BotOutcome, StackStatus } from "./stack.ts";

/** A lock whose control port is not written yet is a launcher still starting; after this it is a crashed one. */
const LOCK_PORT_GRACE_MS = 60_000;
const STATUS_REQUEST_TIMEOUT_MS = 2_000;
/** Lines kept for a console that attaches late: the start banner and what happened since. */
const MAX_BACKLOG_LINES = 200;
/**
 * A comment line to every attached stream this often. Bun's fetch ends a response with no byte for 360 s with
 * `TimeoutError` (measured 2026-10-31, Bun 1.4.2, `.agent/scripts/installer/launcher-probes/sse-idle.ts`), and a console that
 * ends closes its socket, which stops the stack. 30 s is far under that and costs a few bytes.
 */
export const STREAM_HEARTBEAT_MS = 30_000;
/** A POST needs this header: a web page cannot send it to 127.0.0.1 without a preflight, which this server never answers. */
export const CONTROL_HEADER = "x-mine-ai-control";

// ---------- the lock file ----------

const lockSchema = z.object({ pid: z.number().int(), controlPort: z.number().int().nullable(), startedAt: z.number() });
export type LauncherLock = z.infer<typeof lockSchema>;

export interface LockDeps {
  isPidAlive(pid: number): boolean;
  fetch: typeof fetch;
  now(): number;
}

export const launcherLockFile = (root: string): string => join(root, "run", "launcher.json");

/** True while a process with this pid exists (`kill(pid, 0)` sends nothing); a process we may not signal still exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const realLockDeps: LockDeps = { isPidAlive: isProcessAlive, fetch, now: Date.now };

function readLock(root: string): LauncherLock | null {
  try {
    return lockSchema.parse(JSON.parse(readFileSync(launcherLockFile(root), "utf8")));
  } catch {
    return null;
  }
}

async function answersStatus(port: number, deps: LockDeps): Promise<boolean> {
  try {
    return (await deps.fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

/** A launcher is live when its process exists and its control port answers `/status`; a pid reused by another program does not answer. */
async function isLive(lock: LauncherLock, deps: LockDeps): Promise<boolean> {
  if (!deps.isPidAlive(lock.pid)) return false;
  if (lock.controlPort === null) return deps.now() - lock.startedAt < LOCK_PORT_GRACE_MS;
  return await answersStatus(lock.controlPort, deps);
}

/** The live launcher of this data root, or null. */
export async function findRunningLauncher(root: string, deps: LockDeps = realLockDeps): Promise<LauncherLock | null> {
  const lock = readLock(root);
  return lock !== null && (await isLive(lock, deps)) ? lock : null;
}

export type LockResult = { readonly kind: "acquired" } | { readonly kind: "running"; readonly lock: LauncherLock };

/**
 * Takes `run/launcher.json` for this process (exclusive create, so two launchers starting together cannot both win).
 * A lock that is not live is replaced. The control port is written later with `setLockControlPort`.
 */
export async function acquireLauncherLock(root: string, deps: LockDeps & { ownPid: number } = { ...realLockDeps, ownPid: process.pid }): Promise<LockResult> {
  const file = launcherLockFile(root);
  mkdirSync(join(root, "run"), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: deps.ownPid, controlPort: null, startedAt: deps.now() }), { flag: "wx" });
      return { kind: "acquired" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const lock = readLock(root);
    if (lock !== null && (await isLive(lock, deps))) return { kind: "running", lock };
    // Another launcher may have replaced the stale lock since it was read: only remove what was judged stale.
    if (JSON.stringify(readLock(root)) === JSON.stringify(lock)) rmSync(file, { force: true });
  }
  throw new Error(`Could not take ${file}: another launcher keeps replacing it. Close Mine AI and try again.`);
}

/** Records the control port the launcher listens on, for the console and the `stop`, `status` and `bot` commands. */
export function setLockControlPort(root: string, port: number): void {
  const lock = readLock(root);
  if (lock === null) throw new Error(`${launcherLockFile(root)} is missing or unreadable; the launcher cannot publish its control port.`);
  const temporary = `${launcherLockFile(root)}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...lock, controlPort: port }));
  renameSync(temporary, launcherLockFile(root));
}

/** Removes the lock when it is ours; the lock of a launcher that replaced ours stays. */
export function releaseLauncherLock(root: string, ownPid: number): void {
  if (existsSync(launcherLockFile(root)) && readLock(root)?.pid === ownPid) rmSync(launcherLockFile(root), { force: true });
}

// ---------- the endpoint ----------

/** What the control server needs of the stack and the launcher. */
export interface ControlHandlers {
  status(): StackStatus;
  startBot(id: string): Promise<BotOutcome>;
  stopBot(id: string): Promise<BotOutcome>;
  /** `POST /stop`: starts the ordered stop and returns; the launcher exits when it is done. */
  stop(): Promise<void>;
  /** The last attached console went away (closed, killed): run the ordered stop. Called once. */
  onLastStreamClosed(): void;
}

export interface ControlServer {
  readonly port: number;
  /** One line to every attached console, and to those attaching later. */
  publish(line: string): void;
  /** True once any console attached (even if it left again). */
  hasConsoleAttached(): boolean;
  close(): Promise<void>;
}

export interface ControlOptions {
  readonly startPort: number;
  readonly handlers: ControlHandlers;
  readonly freePort?: typeof freePort;
  /** Pause between the `: ping` lines of an attached stream; tests shorten it. */
  readonly heartbeatMs?: number;
  /** Starts the repeating heartbeat timer and returns what stops it; tests pass a fake they fire by hand. */
  readonly startTimer?: StartTimer;
}

export type StartTimer = (tick: () => void, everyMs: number) => () => void;

/** A repeating timer that never keeps the process alive: a pending ping must not hold up the launcher's exit. */
export const startUnrefTimer: StartTimer = (tick, everyMs) => {
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};

const HTTP_STATUS_OF_REFUSAL: Record<Extract<BotOutcome, { ok: false }>["reason"], number> = {
  "unknown-persona": 404,
  "not-ready": 409,
  "already-running": 409,
  "not-running": 409,
  failed: 500,
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendOutcome(response: ServerResponse, outcome: BotOutcome): void {
  sendJson(response, outcome.ok ? 200 : HTTP_STATUS_OF_REFUSAL[outcome.reason], { ok: outcome.ok, message: outcome.message });
}

class Console {
  private readonly streams = new Set<ServerResponse>();
  private readonly backlog: string[] = [];
  private closedOnce = false;
  private everAttached = false;
  private stopHeartbeatTimer: (() => void) | null = null;

  constructor(
    private readonly onLastClosed: () => void,
    private readonly heartbeatMs: number,
    private readonly startTimer: StartTimer,
  ) {}

  publish(line: string): void {
    for (const part of line.split(/\r?\n/u)) {
      this.backlog.push(part);
      if (this.backlog.length > MAX_BACKLOG_LINES) this.backlog.shift();
      for (const stream of this.streams) stream.write(`data: ${part}\n\n`);
    }
  }

  attach(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // A comment line: headers reach the console now, not with the first real line.
    response.write(": attached\n\n");
    for (const line of this.backlog) response.write(`data: ${line}\n\n`);
    this.streams.add(response);
    this.everAttached = true;
    this.startHeartbeat();
    response.once("close", () => {
      this.streams.delete(response);
      if (this.streams.size === 0) this.stopHeartbeat();
      if (this.streams.size === 0 && this.everAttached && !this.closedOnce) {
        this.closedOnce = true;
        this.onLastClosed();
      }
    });
  }

  hasEverAttached(): boolean {
    return this.everAttached;
  }

  endAll(): void {
    this.closedOnce = true;
    this.stopHeartbeat();
    for (const stream of this.streams) stream.end();
  }

  /** One timer for all streams, started by the first attach and stopped with the last stream. */
  private startHeartbeat(): void {
    if (this.stopHeartbeatTimer !== null) return;
    this.stopHeartbeatTimer = this.startTimer(() => {
      for (const stream of this.streams) stream.write(": ping\n\n");
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    this.stopHeartbeatTimer?.();
    this.stopHeartbeatTimer = null;
  }
}

/** Serves the control endpoint on the first free port from `startPort` (written to the lock by the caller). */
export async function startControlServer(options: ControlOptions): Promise<ControlServer> {
  const { handlers } = options;
  const port = await (options.freePort ?? freePort)(options.startPort);
  const attached = new Console(() => handlers.onLastStreamClosed(), options.heartbeatMs ?? STREAM_HEARTBEAT_MS, options.startTimer ?? startUnrefTimer);
  const server = createServer((request, response) => {
    route(request, response, port, handlers, attached).catch((error: unknown) => sendJson(response, 500, { ok: false, message: String(error) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { port, publish: (line) => attached.publish(line), hasConsoleAttached: () => attached.hasEverAttached(), close: () => closeServer(server, attached) };
}

function closeServer(server: Server, attached: Console): Promise<void> {
  attached.endAll();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function isLoopbackHost(request: IncomingMessage, port: number): boolean {
  return request.headers.host === `127.0.0.1:${port}` || request.headers.host === `localhost:${port}`;
}

async function route(request: IncomingMessage, response: ServerResponse, port: number, handlers: ControlHandlers, attached: Console): Promise<void> {
  if (!isLoopbackHost(request, port)) return sendJson(response, 403, { ok: false, message: "Refused: this endpoint answers 127.0.0.1 only." });
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && path === "/status") return sendJson(response, 200, handlers.status());
  // Attaching holds the stack up and dropping the stream stops it, so it is as much a command as a POST.
  const isCommand = request.method === "POST" || path === "/attach";
  if (isCommand && request.headers[CONTROL_HEADER] !== "1") return sendJson(response, 403, { ok: false, message: `Refused: ${request.method} ${path} needs the ${CONTROL_HEADER}: 1 header.` });
  if (request.method === "GET" && path === "/attach") return attachConsole(response, handlers, attached);
  if (request.method === "POST") return await routePost(path, response, handlers);
  sendJson(response, 404, { ok: false, message: `No such path: ${path}. Paths: GET /status, GET /attach, POST /bots/<id>/start|stop, POST /stop.` });
}

function attachConsole(response: ServerResponse, handlers: ControlHandlers, attached: Console): void {
  const { phase } = handlers.status();
  if (phase === "stopping" || phase === "stopped") return sendJson(response, 503, { ok: false, message: "Mine AI is stopping; wait a few seconds, then open the console again." });
  attached.attach(response);
}

async function routePost(path: string, response: ServerResponse, handlers: ControlHandlers): Promise<void> {
  if (path === "/stop") {
    await handlers.stop();
    return sendJson(response, 200, { ok: true, message: "Stopping." });
  }
  const bot = /^\/bots\/([^/]+)\/(start|stop)$/u.exec(path);
  if (!bot) return sendJson(response, 404, { ok: false, message: `No such path: ${path}.` });
  let id: string;
  try {
    id = decodeURIComponent(bot[1]!);
  } catch {
    return sendJson(response, 400, { ok: false, message: "The persona id or username is not valid text." });
  }
  sendOutcome(response, bot[2] === "start" ? await handlers.startBot(id) : await handlers.stopBot(id));
}
