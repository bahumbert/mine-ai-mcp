// A body the supervisor keeps down: the failure it answers with, `BodyDown`, and what the work loop shows and waits.
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** When the supervisor starts a stopped runtime again: its time (ISO), the attempt and the attempts it allows in a row. */
export interface BodyRestart { readonly at: string; readonly attempt: number; readonly of: number }

/** A call the supervisor answered with its saved failure: the body is down; `restart` null = down until the host restarts. */
export class BodyDown extends Error {
  constructor(readonly restart: BodyRestart | null, override readonly cause: Error) {
    super(cause.message);
  }
}

/** The supervisor's saved failure as the JSON-RPC error carries it in `data`; `restart` is absent from an older host. */
const supervisorFailureSchema = z.object({
  code: z.string().startsWith("RUNTIME_"),
  restart: z.object({ at: z.string(), attempt: z.number(), of: z.number() }).nullish(),
});

/** What the supervisor's failure says about the restart (null = none to come), or null when the error is not the supervisor's. */
export function supervisorFailureOf(error: Error): { readonly restart: BodyRestart | null } | null {
  if (!(error instanceof McpError)) return null;
  const failure = supervisorFailureSchema.safeParse(error.data);
  return failure.success ? { restart: failure.data.restart ?? null } : null;
}

/** `error` as {@link BodyDown} when the supervisor answered with its failure; any other error as it is. */
export function bodyDownIfSupervisor(error: Error): Error {
  const failure = supervisorFailureOf(error);
  return failure === null ? error : new BodyDown(failure.restart, error);
}

/** What the monitor shows while the supervisor keeps the body down; `wallNow` is wall time (`restart.at` is another process's). */
export function bodyDownState(restart: BodyRestart | null, wallNow: number): string {
  if (restart === null) return "my body is down until the host restarts";
  const at = Date.parse(restart.at);
  if (Number.isNaN(at)) return "my body is down";
  if (at <= wallNow) return "my body is starting again";
  return `my body is down; it starts again at ${new Date(at).toISOString().slice(11, 16)}Z (try ${restart.attempt} of ${restart.of})`;
}

/** How long the work loop waits before asking again: the usual error wait, cut to the restart time (one poll at least). */
export function bodyDownWait(usualMs: number, restart: BodyRestart | null, pollMs: number, wallNow: number): number {
  if (restart === null) return usualMs;
  const left = Date.parse(restart.at) - wallNow;
  return Number.isNaN(left) ? usualMs : Math.min(usualMs, Math.max(pollMs, left));
}
