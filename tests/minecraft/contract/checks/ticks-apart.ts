/** What two packets heard `min` to `max` server ticks apart look like to a check that reads the tick as each was heard (`heardAt`): one assertion and one message for the fireball and knockback checks. */
import assert from "node:assert/strict";

/** `later` came `min` to `max` server ticks after `earlier` (both ticks as read at the hearing, never out of order). */
export function assertTicksApart(what: string, earlier: number, later: number, window: { readonly min: number; readonly max: number }): void {
  assert.ok(later - earlier >= window.min && later - earlier <= window.max, `${what}: ${later - earlier} server ticks (read at ticks ${earlier} and ${later}), not ${window.min} to ${window.max}`);
}
