/**
 * MCP sessions over the runtime child's IPC channel (plan 2026-11-18-in-process-runtime, D1): the brain's client and the
 * runtime's `Server` exchange {@link linkMessageSchema} frames on the channel the supervisor already owns, beside the
 * runtime's heartbeat. A message over {@link LINK_PART_BYTES} is cut into parts and one part is in flight at a time, so a
 * heartbeat sent between two parts never waits behind a whole 4 MB reply (measured: 3.5 s late behind 20 such replies,
 * `.agent/reports/2026-11-18-in-process-baseline.md`).
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { jsonRpcMessageSchema, linkMessageSchema, type LinkMessage } from "./runtime-liveness.js";

/** A message whose JSON is longer than this (in characters, which are bytes for the mostly ASCII JSON-RPC) goes in parts. */
export const LINK_PART_BYTES = 256 * 1024;
/** Session or message ids remembered to log a drop once; the oldest is forgotten past this many. */
const REMEMBERED_KEYS = 1_024;

/** What a link needs of an IPC endpoint; `process` in the child (through a small adapter) and a `ChildProcess` fit. */
export interface IpcChannel {
  /** `false` once the other end is gone; absent means "not known". */
  readonly connected?: boolean;
  /** `callback` runs when the message was written, with the error when it could not be (it never throws). */
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (raw: unknown) => void): unknown;
  off(event: "message", listener: (raw: unknown) => void): unknown;
}

/**
 * A child process's channel to its parent as the link sees it. `process.send` takes its callback as the second argument
 * only when it is given (an `undefined` there does not type-check as a send handle).
 */
export function processIpcChannel(child: NodeJS.Process = process): IpcChannel {
  return {
    get connected() {
      return child.connected;
    },
    send: (message, callback) => (callback ? child.send!(message, callback) : child.send!(message)),
    on: (event, listener) => child.on(event, listener),
    off: (event, listener) => child.off(event, listener),
  };
}

/** What `/health` shows of the link: sessions open now and events pushed over it. */
export interface LinkStats {
  open: number;
  pushed: number;
}

type WholeFrame = Extract<LinkMessage, { kind: "mcp" }>;
type PartFrame = Extract<LinkMessage, { kind: "mcp-part" }>;

/** Keys remembered so that a repeated drop is logged once; bounded, so a long run does not keep every session id. */
function createRecentKeys() {
  const keys = new Set<string>();
  return {
    /** `true` the first time a key is seen. */
    add(key: string): boolean {
      if (keys.has(key)) return false;
      keys.add(key);
      if (keys.size > REMEMBERED_KEYS) keys.delete(keys.values().next().value!);
      return true;
    },
    has: (key: string) => keys.has(key),
  };
}

export interface LinkSender {
  /** Queues a message of a session; `false` when nothing is written (channel gone or sender disposed). */
  send(session: string, message: JSONRPCMessage): boolean;
  open(session: string): boolean;
  close(session: string): boolean;
  /** Drops what is queued and refuses new messages (the channel is gone). */
  dispose(): void;
}

/** The end of `json` to cut at: `LINK_PART_BYTES` on, one earlier when that would split a surrogate pair. */
function partEnd(json: string, start: number): number {
  const end = Math.min(json.length, start + LINK_PART_BYTES);
  if (end === json.length) return end;
  const last = json.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

function framesOf(session: string, message: JSONRPCMessage, id: string): LinkMessage[] {
  const json = JSON.stringify(message);
  if (json.length <= LINK_PART_BYTES) return [{ kind: "mcp", session, message }];
  const pieces: string[] = [];
  for (let start = 0; start < json.length; ) {
    const end = partEnd(json, start);
    pieces.push(json.slice(start, end));
    start = end;
  }
  return pieces.map((data, index) => ({ kind: "mcp-part", session, id, index, count: pieces.length, data }));
}

/**
 * One queue per channel: the next frame is written from the previous write's callback, so at most one is in flight and a
 * message sent on the channel without this queue (a heartbeat) goes between two pieces, not after the whole burst.
 * A failed write ends the sender: the frames behind it are dropped and `onSendError` hears of it once; whoever owns the
 * channel answers what was pending (the supervisor on the child's exit, the child by exiting on disconnect).
 */
export function createLinkSender(
  channel: IpcChannel,
  options: { readonly onSendError?: (error: Error) => void } = {},
): LinkSender {
  const queue: LinkMessage[] = [];
  let writing = false;
  let ended = false;
  let nextMessageId = 0;
  const end = (error?: Error) => {
    if (ended) return;
    ended = true;
    queue.length = 0;
    if (error) options.onSendError?.(error);
  };
  const pump = () => {
    if (writing || ended) return;
    const frame = queue.shift();
    if (frame === undefined) return;
    writing = true;
    try {
      channel.send(frame, (error) => {
        writing = false;
        if (error) end(error);
        else pump();
      });
    } catch (cause) {
      writing = false;
      end(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };
  const enqueue = (frames: LinkMessage[]): boolean => {
    if (ended || channel.connected === false) return false;
    queue.push(...frames);
    pump();
    return true;
  };
  return {
    send: (session, message) => enqueue(framesOf(session, message, String(nextMessageId++))),
    open: (session) => enqueue([{ kind: "mcp-open", session }]),
    close: (session) => enqueue([{ kind: "mcp-close", session }]),
    dispose: () => end(),
  };
}

interface Assembly {
  readonly count: number;
  readonly parts: Map<number, string>;
}
type PartOutcome = { kind: "waiting" } | { kind: "misfit" } | { kind: "joined"; json: string };

/**
 * Adds one part to its message's assembly. A part whose count differs from its message's, whose index is outside the
 * count or was seen already ends that message (`misfit`: it can never join correctly). Parts are kept by index, so a
 * corrupt count cannot allocate an array.
 */
function addPart(assemblies: Map<string, Map<string, Assembly>>, frame: PartFrame): PartOutcome {
  const forSession = assemblies.get(frame.session) ?? new Map<string, Assembly>();
  assemblies.set(frame.session, forSession);
  const assembly = forSession.get(frame.id) ?? { count: frame.count, parts: new Map<number, string>() };
  const fits = frame.count >= 1 && frame.count === assembly.count && frame.index >= 0 && frame.index < frame.count;
  if (!fits || assembly.parts.has(frame.index)) {
    forSession.delete(frame.id);
    return { kind: "misfit" };
  }
  assembly.parts.set(frame.index, frame.data);
  if (assembly.parts.size < assembly.count) {
    forSession.set(frame.id, assembly);
    return { kind: "waiting" };
  }
  forSession.delete(frame.id);
  return { kind: "joined", json: Array.from({ length: assembly.count }, (_, index) => assembly.parts.get(index)!).join("") };
}

export interface LinkReceiver {
  /** Hands over a whole message, or the message the parts of one id add up to once the last part arrived. */
  receive(frame: WholeFrame | PartFrame): void;
  /** The session closed: its half-joined messages are dropped and later frames of it are refused. */
  discardSession(session: string): void;
}

/** Joins `mcp-part` frames by (session, id); every drop is logged once per session. */
export function createLinkReceiver(
  onMessage: (session: string, message: JSONRPCMessage) => void,
  log: (line: string) => void,
): LinkReceiver {
  const assemblies = new Map<string, Map<string, Assembly>>();
  const closed = createRecentKeys();
  const loggedDrops = createRecentKeys();
  const drop = (session: string, reason: string) => {
    if (loggedDrops.add(`${reason}:${session}`)) log(`[LINK_DROPPED] ${reason} for session ${session}.`);
  };
  const deliverJoined = (session: string, json: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      drop(session, "a joined message that is not JSON");
      return;
    }
    const message = jsonRpcMessageSchema.safeParse(parsed);
    if (message.success) onMessage(session, message.data);
    else drop(session, "a joined message that is not JSON-RPC");
  };
  return {
    receive(frame) {
      if (closed.has(frame.session)) {
        drop(frame.session, "a message of a closed session");
        return;
      }
      if (frame.kind === "mcp") {
        onMessage(frame.session, frame.message);
        return;
      }
      const joined = addPart(assemblies, frame);
      if (joined.kind === "joined") deliverJoined(frame.session, joined.json);
      else if (joined.kind === "misfit") drop(frame.session, "a part whose count or index does not fit");
    },
    discardSession(session) {
      assemblies.delete(session);
      closed.add(session);
    },
  };
}

/** The runtime's end of one session: sends through the channel's queue, closes once. */
class IpcServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private closed = false;
  constructor(
    private readonly sender: LinkSender,
    private readonly session: string,
  ) {}
  async start(): Promise<void> {}
  /** A message the channel cannot take is dropped: the other end is gone and the supervisor answers what it forwarded. */
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.closed) this.sender.send(this.session, message);
  }
  deliver(message: JSONRPCMessage): void {
    if (!this.closed) this.onmessage?.(message);
  }
  async close(): Promise<void> {
    this.end(true);
  }
  /** The other end closed the session: nothing is sent back. */
  closedByPeer(): void {
    this.end(false);
  }
  private end(tellPeer: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (tellPeer) this.sender.close(this.session);
    this.onclose?.();
  }
}

interface OpenSession {
  readonly server: Server;
  readonly transport: IpcServerTransport;
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The runtime's side of the link: a `mcp-open` frame creates a server with `createServer` and connects it to a session
 * transport; `mcp` and `mcp-part` frames go to their session, `mcp-close` closes it. A frame for a session that is not
 * open is dropped and logged once per session id. Frames {@link linkMessageSchema} refuses are not ours and are ignored.
 * Disposing closes every session (each peer is told). `stats.open` counts the open sessions.
 */
export function serveLinkSessions(
  channel: IpcChannel,
  createServer: () => Server,
  log: (line: string) => void,
  stats: LinkStats,
): Disposable {
  const sender = createLinkSender(channel, { onSendError: (error) => log(`[LINK_SEND_FAILED] ${error.message}`) });
  const sessions = new Map<string, OpenSession>();
  const unknownLogged = createRecentKeys();
  const receiver = createLinkReceiver((session, message) => sessions.get(session)?.transport.deliver(message), log);
  const dropUnknown = (session: string, kind: string) => {
    if (unknownLogged.add(session)) log(`[LINK_DROPPED] a ${kind} frame for session ${session}, which is not open.`);
  };
  const openSession = (session: string) => {
    if (sessions.has(session)) {
      log(`[LINK_DROPPED] a second mcp-open for session ${session}, which is open.`);
      return;
    }
    let server: Server;
    try {
      server = createServer();
    } catch (cause) {
      log(`[LINK_SESSION_FAILED] session ${session}: ${describe(cause)}`);
      sender.close(session); // The client is told, instead of waiting for a session that never answers.
      return;
    }
    const transport = new IpcServerTransport(sender, session);
    sessions.set(session, { server, transport });
    stats.open++;
    transport.onclose = () => {
      if (!sessions.delete(session)) return;
      stats.open--;
      receiver.discardSession(session);
    };
    server.connect(transport).catch((cause: unknown) => {
      log(`[LINK_SESSION_FAILED] session ${session}: ${describe(cause)}`);
      void transport.close();
    });
  };
  const onFrame = (raw: unknown) => {
    const parsed = linkMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === "mcp-open") {
      openSession(frame.session);
      return;
    }
    const open = sessions.get(frame.session);
    if (!open) {
      dropUnknown(frame.session, frame.kind);
      return;
    }
    if (frame.kind === "mcp-close") open.transport.closedByPeer();
    else receiver.receive(frame);
  };
  channel.on("message", onFrame);
  return {
    [Symbol.dispose]() {
      channel.off("message", onFrame);
      for (const { server } of [...sessions.values()]) {
        server.close().catch((cause: unknown) => log(`[LINK_SESSION_FAILED] closing: ${describe(cause)}`));
      }
    },
  };
}
