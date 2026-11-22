// Checks and extraction for replies from the brain's models.
import type { Step } from "./actions.ts";

/** Models often wrap JSON in prose or code fences; take the outermost object. */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object in the reply");
  return text.slice(start, end + 1);
}

const SIGN_SUSPECT_DISTANCE = 256;
const SIGN_FIXED_DISTANCE = 128;

/** A step coordinate whose opposite sign would put it near the bot, or null. */
export function signFlipped(step: Step, at: { readonly x: number; readonly z: number }): string | null {
  const target = step as { readonly x?: unknown; readonly z?: unknown };
  if (typeof target.x !== "number" || typeof target.z !== "number") return null;
  const { x, z } = target;
  const far = Math.hypot(x - at.x, z - at.z);
  if (far < SIGN_SUSPECT_DISTANCE) return null;
  for (const [name, turned] of [["x", { x: -x, z }], ["z", { x, z: -z }], ["x and z", { x: -x, z: -z }]] as const) {
    const near = Math.hypot(turned.x - at.x, turned.z - at.z);
    if (near <= SIGN_FIXED_DISTANCE) {
      return `${name} ${name === "z" ? z : x}${name === "x and z" ? ` ${z}` : ""} is ${Math.round(far)} blocks from you, but with the sign turned (${turned.x} ${turned.z}) it is ${Math.round(near)} blocks away: check the minus signs`;
    }
  }
  return null;
}
