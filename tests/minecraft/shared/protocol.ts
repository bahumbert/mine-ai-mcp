// The messages between `submit` and the daemon: one JSON object per line over the unix socket.
import { isAbsolute } from "node:path";
import { z } from "zod";

const absolutePath = z.string().refine(isAbsolute, "paths sent to the daemon must be absolute");

const clientMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("submit"),
    paths: z.array(absolutePath).min(1),
    out: absolutePath,
    repeat: z.number().int().min(1),
    /** `--lanes N`: at most N of this submission's trials at once. */
    lanes: z.number().int().min(1).nullable(),
    lock: z.boolean(),
    /** The submitter's MINE_AI_* variables: the clients run under the daemon, not under the submitter. */
    env: z.record(z.string(), z.string()),
  }),
  z.strictObject({ type: z.literal("status") }),
  z.strictObject({ type: z.literal("stop") }),
]);

const daemonMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("info"), text: z.string() }),
  z.strictObject({ type: z.literal("error"), text: z.string() }),
  z.strictObject({ type: z.literal("wait"), text: z.string() }),
  z.strictObject({
    type: z.literal("result"),
    name: z.string(),
    outcome: z.enum(["pass", "fail", "timeout", "error", "cancelled"]),
    elapsedMs: z.number(),
    detail: z.string(),
    error: z.string().optional(),
    runDir: z.string(),
  }),
  z.strictObject({ type: z.literal("done"), runs: z.number(), passed: z.number(), failed: z.number(), cancelled: z.number() }),
  z.strictObject({ type: z.literal("status"), text: z.string() }),
  z.strictObject({ type: z.literal("stopping") }),
]);

export type ClientMessage = z.infer<typeof clientMessage>;
export type SubmitMessage = Extract<ClientMessage, { type: "submit" }>;
export type DaemonMessage = z.infer<typeof daemonMessage>;

export function encodeMessage(message: ClientMessage | DaemonMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeClientMessage(line: string): ClientMessage {
  return clientMessage.parse(JSON.parse(line));
}

export function decodeDaemonMessage(line: string): DaemonMessage {
  return daemonMessage.parse(JSON.parse(line));
}

/** Splits a byte stream into lines, whatever the chunk boundaries. */
export class LineReader {
  #rest = "";

  push(chunk: string): string[] {
    const lines = (this.#rest + chunk).split("\n");
    this.#rest = lines.pop() ?? "";
    return lines.filter(Boolean);
  }
}
