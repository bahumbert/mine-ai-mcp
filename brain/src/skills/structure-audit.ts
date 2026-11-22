// What a `build_structure` audit says: the cells it refused and why cells were left.
import { z } from "zod";
import { errorCode } from "../runtime-client.ts";

export type Cell = { readonly x: number; readonly y: number; readonly z: number };

export function sameCell(left: Cell, right: Cell): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

/** The part of `build_structure`'s audit that names the cells it left refused (src/actions/build-structure/contract.ts `left`). */
const refusedAuditSchema = z.object({
  structure: z.object({
    left: z.array(z.object({ reason: z.string(), count: z.number(), named: z.array(z.object({ x: z.number(), y: z.number(), z: z.number(), cause: z.string().optional() })) })),
  }),
});

/**
 * The cells a `build_structure` audit says were refused for good: by policy (named ones only: the runtime names a few
 * per reason). A body in the cell, a route that failed or a placement that did not take may pass on the next try, so
 * they do not count toward giving the house up.
 */
export function refusedCells(result: Readonly<Record<string, unknown>> | undefined): Cell[] {
  const parsed = refusedAuditSchema.safeParse(result);
  if (!parsed.success) return [];
  return parsed.data.structure.left.filter((group) => group.reason === "refused").flatMap((group) => group.named.filter((cell) => cell.cause === "policy").map(({ x, y, z }) => ({ x, y, z })));
}

const leftGroupsSchema = z.object({ structure: z.object({ left: z.array(z.object({ reason: z.string(), named: z.array(z.object({ cause: z.string().optional() })) })) }) });

/**
 * Whether a failed `build_structure` ended for want of a route: the run's last routes found no way (its cells left
 * `not_reached`, still workable), or a cell was refused for cause `route`. The audit's own groups say it; the error text
 * is not read. A call sent with a `reserve_items` that ends so is sent once more without it (plan 2026-11-14 Task 7b).
 */
export function endedForWantOfRoute(error: string | null | undefined, result: Readonly<Record<string, unknown>> | undefined): boolean {
  if (error === undefined || error === null || !(error.startsWith("[BUILD_STOPPED]") || error.startsWith("[BUILD_INCOMPLETE]"))) return false;
  const parsed = leftGroupsSchema.safeParse(result);
  if (!parsed.success) return false;
  return parsed.data.structure.left.some((group) => group.reason === "not_reached" || group.named.some((cell) => cell.cause === "route"));
}

/** How many cells a `build_structure` audit left, when every one of them was refused (0 when some other reason is in it). */
export function onlyRefused(result: Readonly<Record<string, unknown>> | undefined): number {
  const parsed = refusedAuditSchema.safeParse(result);
  if (!parsed.success || !parsed.data.structure.left.every((group) => group.reason === "refused")) return 0;
  return parsed.data.structure.left.reduce((sum, group) => sum + group.count, 0);
}

/** The part of `build_structure`'s audit the skill reports (src/actions/build-structure/contract.ts). */
const structureAuditSchema = z.object({
  structure: z.object({
    placed: z.number(),
    dug: z.number(),
    left: z.array(z.object({ reason: z.string(), count: z.number() })),
    missing: z.array(z.object({ block: z.string(), count: z.number() })),
  }),
});

/**
 * Why cells were left, for the planner: `[BUILD_INCOMPLETE]` errors already list it, but `[BUILD_STOPPED]` and
 * tool-loss errors do not.
 */
export function auditSuffix(error: string | null, result: Readonly<Record<string, unknown>> | undefined): string {
  if (errorCode(error) === "BUILD_INCOMPLETE") return "";
  const parsed = structureAuditSchema.safeParse(result);
  if (!parsed.success) return "";
  const { placed, dug, left, missing } = parsed.data.structure;
  const parts = [`placed ${placed}, dug ${dug}`];
  if (left.length > 0) parts.push(`left ${left.map((group) => `${group.count} ${group.reason}`).join(", ")}`);
  if (missing.length > 0) parts.push(`short of ${missing.map((entry) => `${entry.count} ${entry.block}`).join(", ")}`);
  return ` (${parts.join("; ")})`;
}
