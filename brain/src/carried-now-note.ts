// The note that tells a model its refused build can go on: everything it was missing is carried now.
import { STAND_ON_WORDS } from "./building/stage-progress.ts";
import type { WorkInput } from "./mind.ts";
import { NEW_HOUSE_NOTE } from "./protected-areas.ts";

/**
 * A build refused for missing materials, when all of them are carried now: said, since the model did not see it (live
 * 2026-10-04: given everything a house lacked, Ayla went on looking for logs for 20 more steps and never built). It quotes
 * the step the refusal gave (the house's own, with its door), else says to build again.
 */
export function nowCarried(input: WorkInput): string {
  const refused = input.steps.findLast((record) => record.outcome === "failed" && /^missing .+ for .+ \(the rest is carried\)/u.test(record.detail));
  if (refused === undefined) return "";
  const [, list = "", what = ""] = /^missing (.+?) for (.+?) \(the rest is carried\)/u.exec(refused.detail) ?? [];
  const carried = new Map<string, number>();
  for (const stack of input.snapshot.inventory) carried.set(stack.name, (carried.get(stack.name) ?? 0) + stack.count);
  const needed = list.split(", ").map((part) => /^(\d+) ([a-z0-9_]+)$/u.exec(part.trim())).filter((match) => match !== null);
  if (needed.length === 0 || needed.some((match) => (carried.get(match[2]!) ?? 0) < Number(match[1]))) return "";
  // A refusal that offered a new site first names the old house's step: quoting the first step there would push the replacement.
  // One that lacks blocks to stand on lacks what the inventory list above cannot show.
  if (refused.detail.includes(NEW_HOUSE_NOTE) || refused.detail.includes(STAND_ON_WORDS)) return "";
  const step = /\{"skill":"build"[^}]*\}/u.exec(refused.detail)?.[0];
  return `Everything ${what} was missing (${list}) is carried now: ${step ?? "build it again."}`;
}
