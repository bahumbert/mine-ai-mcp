/**
 * The supervisor's end of the brain's MCP links (plan 2026-11-18-in-process-runtime T2): each link is an SDK `Transport`
 * the brain connects a `Client` to, carried over the runtime child's IPC channel by the frames of `ipc-transport.ts`.
 * The supervisor answers for the runtime: a request in flight when the runtime fails gets the failure as its JSON-RPC
 * error, then the link closes; a link never outlives the child it was opened on.
 */
import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createLinkReceiver,
  createLinkSender,
  type IpcChannel,
  type LinkReceiver,
  type LinkSender,
} from "./ipc-transport.js";
import { linkMessageSchema } from "./runtime-liveness.js";

/** The parts of a JSON-RPC message the supervisor reads: who it answers (`id`), what it asks (`method`, the tool's name). */
export const envelopeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.object({ name: z.string().optional() }).optional(),
});

/** A request a link forwarded that has no reply yet. */
interface PendingLinkRequest {
  readonly method: string | null;
  readonly tool: string | null;
}

/** One brain session: the transport its client uses and the requests it is waiting for. */
export class SupervisorLink implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly pending = new Map<RequestId, PendingLinkRequest>();
  closed = false;
  constructor(
    readonly session: string,
    private readonly hub: LinkHub,
  ) {}
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("[LINK_CLOSED] this link to the runtime is closed: open a new one.");
    this.hub.forward(this, message);
  }
  async close(): Promise<void> {
    this.hub.closeLink(this.session, { tellRuntime: true });
  }
  /** A message for the client; a reply ends the wait for its request. */
  deliver(message: JSONRPCMessage): void {
    const envelope = envelopeSchema.safeParse(message);
    if (envelope.success && envelope.data.id !== undefined && envelope.data.method === undefined) this.pending.delete(envelope.data.id);
    this.onmessage?.(message);
  }
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

export interface LinkHubOptions {
  /** Whether a frame may be written to the runtime now (it is `ready`); otherwise a request waits for the failure's answer. */
  readonly accepts: () => boolean;
  /** A line about a problem of the links: a write the child's channel refused, a frame dropped, a client's callback that threw. */
  readonly log: (line: string) => void;
}

/** What `failedRequests` lists of a request a failure ended, for the failure's incident record. */
export interface LinkRequestRecord {
  readonly id: RequestId;
  readonly method: string | null;
  readonly tool: string | null;
  readonly path: "link";
  readonly httpMethod: null;
}

/**
 * All links of one supervisor over its current child. Every write goes through one {@link LinkSender} of the child
 * (a callback on each send, so a dead child's channel never raises an unhandled `'error'`: measured on Bun 1.4.3,
 * `.agent/reports/2026-11-18-in-process-baseline.md`); a new child gets a new sender and receiver.
 */
export class LinkHub {
  private readonly links = new Map<string, SupervisorLink>();
  private sender: LinkSender | null = null;
  private receiver: LinkReceiver | null = null;
  constructor(private readonly options: LinkHubOptions) {}

  /** The runtime child these links belong to from now on; the links of the previous child were closed with its failure. */
  attach(child: IpcChannel): void {
    this.sender?.dispose();
    this.sender = createLinkSender(child, { onSendError: (error) => this.options.log(`link write to the runtime failed: ${error.message}`) });
    this.receiver = createLinkReceiver((session, message) => this.links.get(session)?.deliver(message), this.options.log);
  }

  /** Opens a session on the runtime; `null` when the child's channel is already closed (its failure is being recorded). */
  open(): SupervisorLink | null {
    const link = new SupervisorLink(randomUUID(), this);
    if (this.sender?.open(link.session) !== true) return null;
    this.links.set(link.session, link);
    return link;
  }

  /** Forwards a client's message; a request is remembered until its reply, and one the runtime cannot take waits for the failure. */
  forward(link: SupervisorLink, message: JSONRPCMessage): void {
    const envelope = envelopeSchema.safeParse(message);
    if (envelope.success && envelope.data.id !== undefined && envelope.data.method !== undefined) {
      link.pending.set(envelope.data.id, { method: envelope.data.method, tool: envelope.data.params?.name ?? null });
    }
    if (this.options.accepts()) this.sender?.send(link.session, message);
  }

  /** Routes a frame from the child to its link; `false` when it is not a link frame. */
  route(raw: unknown): boolean {
    const parsed = linkMessageSchema.safeParse(raw);
    if (!parsed.success) return false;
    const frame = parsed.data;
    if (frame.kind === "mcp" || frame.kind === "mcp-part") this.receiver?.receive(frame);
    else if (frame.kind === "mcp-close") this.closeLink(frame.session, { tellRuntime: false });
    return true;
  }

  /** Ends one session; the runtime is told unless it closed the session itself or is gone. */
  closeLink(session: string, { tellRuntime }: { readonly tellRuntime: boolean }): void {
    const link = this.links.get(session);
    if (!link) return;
    this.links.delete(session);
    if (tellRuntime && this.options.accepts()) this.sender?.close(session);
    this.receiver?.discardSession(session);
    link.end();
  }

  /** The requests waiting for a reply on every link. */
  pendingRequests(): LinkRequestRecord[] {
    return [...this.links.values()].flatMap((link) =>
      [...link.pending].map(([id, { method, tool }]) => ({ id, method, tool, path: "link" as const, httpMethod: null })),
    );
  }

  /** The runtime failed: every waiting request gets `failureReply`, then every link closes and the child's sender stops. */
  failAll(failureReply: (id: RequestId) => JSONRPCMessage): void {
    for (const link of [...this.links.values()]) {
      this.ignoringClientThrow(() => {
        for (const id of [...link.pending.keys()]) link.deliver(failureReply(id));
      });
      this.ignoringClientThrow(() => this.closeLink(link.session, { tellRuntime: false }));
    }
    this.sender?.dispose();
  }

  /** A client's callback that throws must not stop the failure reaching the other links nor the restart: it is logged. */
  private ignoringClientThrow(step: () => void): void {
    try {
      step();
    } catch (error) {
      this.options.log(`a link client's callback threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The supervisor stops: every link closes (a client's waiting calls end with "connection closed"). */
  closeAll(): void {
    for (const session of [...this.links.keys()]) this.closeLink(session, { tellRuntime: false });
    this.sender?.dispose();
  }
}
