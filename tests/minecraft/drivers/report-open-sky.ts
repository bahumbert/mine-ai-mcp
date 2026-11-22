import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaCell } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";

const point = z.object({ x: z.number(), y: z.number(), z: z.number() });
const statusSchema = z.object({ situation: z.object({ position: point, navigation: z.object({
  coverExit: z.object({ at: point, plannedAt: z.string().datetime(), reached: z.boolean() }).nullable(),
}) }) });

/** Walk out of a real tunnel and verify the passive report and the unchanged action endpoint. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { target, exit } = z.object({ target: arenaCell(context.arena), exit: arenaCell(context.arena) }).parse(context.scenario.params);
  const initial = await context.call("view_status", {});
  const revision = initial.survivalPolicy?.revision;
  if (!revision) return { status: "failed", detail: "No survival policy revision in view_status" };
  const policy = await context.call("set_survival_policy", { operation: "set", expected_revision: revision,
    changes: { navigation: { report_open_sky: true } }, lifetime: { kind: "session" }, reason: "Report where my route leaves the tunnel" });
  if (policy.result.status !== "succeeded") return { status: "failed", detail: policy.summary };
  const moved = await context.call("navigate", { ...target, range: 0 });
  if (moved.result.status !== "succeeded") return { status: "failed", detail: moved.summary };
  const status = await context.call("view_status", {});
  const { position, navigation: { coverExit } } = statusSchema.parse(status.result).situation;
  const atTarget = Math.floor(position.x) === target.x && Math.floor(position.y) === target.y && Math.floor(position.z) === target.z;
  const reportedExit = coverExit?.reached && coverExit.at.x === exit.x && coverExit.at.y === exit.y && coverExit.at.z === exit.z;
  return { status: atTarget && reportedExit ? "succeeded" : "failed", detail: JSON.stringify({ position, coverExit }) };
}
