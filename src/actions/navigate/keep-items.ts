/** What a `navigate` request's `keep_items` (blocks kept by name) and `reserve_items` (blocks kept by count) change in the route's scaffold. */
import type { Bot } from "mineflayer";
import { fallbackScaffoldItem, preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import type { NavigateRequest } from "./contract.js";

// The movements never place a kept block and place a reserved one only above its count; the fallback scaffold follows
// both, so it neither bridges with what is kept nor hides that the policy list offers nothing.

/** The movement options that keep the request's `keep_items` and `reserve_items` off the route's scaffold; nothing for what it names none of. */
export function keptScaffoldOption(request: NavigateRequest): {
  readonly protectedScaffoldNames?: readonly string[];
  readonly reservedScaffoldCounts?: ReadonlyMap<string, number>;
} {
  return {
    ...(request.keepItems.length > 0 && { protectedScaffoldNames: request.keepItems }),
    ...(request.reserveItems.size > 0 && { reservedScaffoldCounts: request.reserveItems }),
  };
}

/**
 * The carried block a route with no path may be planned again with: none unless the request allows scaffold and no
 * block of the policy's list is left to place (the kept ones set aside, the reserved ones down to their count); then the
 * common block carried the most of, the same ones set aside too.
 */
export function scaffoldFallbackFor(bot: Bot, request: NavigateRequest) {
  if (!request.scaffold) return null;
  const kept = new Set(request.keepItems);
  return preferredScaffoldItem(bot, kept, request.reserveItems) === null ? fallbackScaffoldItem(bot, kept, request.reserveItems) : null;
}
