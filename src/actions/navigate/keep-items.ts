/** What a `navigate` request's `keep_items` (blocks the caller keeps for later work, e.g. a house's bill) changes in the route's scaffold. */
import type { Bot } from "mineflayer";
import { fallbackScaffoldItem, preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import type { NavigateRequest } from "./contract.js";

// The movements never place a kept block and the fallback scaffold skips it too, so it neither bridges nor hides
// that the policy list offers nothing.

/** The movement option that keeps the request's `keep_items` off the route's scaffold; nothing when it keeps none. */
export function keptScaffoldOption(request: NavigateRequest): { readonly protectedScaffoldNames?: readonly string[] } {
  return request.keepItems.length > 0 ? { protectedScaffoldNames: request.keepItems } : {};
}

/**
 * The carried block a route with no path may be planned again with: none unless the request allows scaffold and no
 * block of the policy's list is left to place (the kept ones set aside); then the common block carried the most of,
 * the kept ones set aside too.
 */
export function scaffoldFallbackFor(bot: Bot, request: NavigateRequest) {
  if (!request.scaffold) return null;
  const kept = new Set(request.keepItems);
  return preferredScaffoldItem(bot, kept) === null ? fallbackScaffoldItem(bot, kept) : null;
}
