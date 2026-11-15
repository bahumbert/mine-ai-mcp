/**
 * What a driver does before its next `navigate` after fire or lava: wait until the bot is not burning and no action holds the body.
 * The fire reflex claims the body again each time it senses fire (`src/survival/reflexes/fire.ts:143-145`, stand-down 2 s) and a `navigate` that lands
 * on a claim is refused `ACTION_BUSY` (the runtime's design, not a fault): the driver waits instead of racing the burn.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioContext } from "../scenario.ts";
import { isBurning } from "../../../src/survival/perception/body.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";

/**
 * The bound, in ticks of the world age (the server's own ticks: a slow server takes more wall seconds for the same burn). Measured over 30 runs of
 * `lava-pool-two-deep-foreign-region` (plan 2026-11-15-p4-32-33-red-fixes T1): the fire was out 15.04 to 15.25 s after the last tick in lava in 19 runs, and
 * 16.58 to 16.91 s in 11 (338 ticks at the worst); those 11 are runs where the bot went back into the pool about 12 s after its escape, so the last tick in lava is
 * a second contact and the burn restarts there (`lava-pool-region.ts` records it). The plan's 340 ticks (lava's 300-tick burn, facts `fire-lava-escape.md`, plus 40)
 * left 2 ticks over the worst run; 400 is the worst run plus the 19 ticks the world age can be behind (`ContractSubject.serverTicks`) plus a margin of 43.
 * A fire block's burn is unmeasured and takes the same bound.
 */
export const BODY_FREE_BOUND_TICKS = 400;
/**
 * The wall guard on top of the tick bound, for a server that stops (then the world age never moves: facts `scenario-timing-pitfalls.md`, "A limit must work when its
 * clock stops"). 1.5 times the bound at 20 ticks a second: past the 20 s a server on time needs, and the scenarios' goal of 50 s still ends after it.
 */
export const BODY_FREE_WALL_GUARD_MS = 30_000;
const POLL_MS = 100;

/** The moment a burn starts, on both clocks: the last tick in lava, or the moment the fire was lit. */
export interface BurnStart {
  readonly atMs: number;
  readonly age: number;
}

/** A burn that starts now. */
export function burnStartNow(bot: Bot): BurnStart {
  return { atMs: monotonicNow(), age: bot.time.age };
}

/** The action that holds the body (`view_status` `activeAction`): undefined when none does, null when the status call did not answer (the body is then not known to be free). */
async function readActiveOwner(context: ScenarioContext): Promise<string | undefined | null> {
  const parsed = viewStatusResultSchema.safeParse((await context.call("view_status", {})).result);
  if (!parsed.success || parsed.data.status !== "succeeded") return null;
  return parsed.data.situation.activity.activeAction?.action ?? undefined;
}

/** The action that holds the body now, undefined when none does or the status call did not answer. */
export async function activeActionOwner(context: ScenarioContext): Promise<string | undefined> {
  return (await readActiveOwner(context)) ?? undefined;
}

/**
 * How the wait ended: `reason` says it in words; `owners` is every action seen holding the body while it waited, in order; `burning` the client's flag at the end.
 * `afterStartTicks` and `fireOutAfterTicks` count world-age ticks from the start the driver gave (the burn's clock, up to 19 ticks behind): the end of the wait, and the first poll
 * that saw no fire (null: never). The bound comes from these; `waitedMs` counts wall time from the call and says how long the driver stood still.
 */
export interface BodyFreeWait {
  readonly freed: boolean;
  readonly reason: string;
  readonly waitedMs: number;
  readonly afterStartTicks: number;
  readonly fireOutAfterTicks: number | null;
  readonly burning: boolean;
  readonly owners: readonly string[];
}

/**
 * Wait until the bot is not burning and no action holds the body, at most `BODY_FREE_BOUND_TICKS` of world age after `since` (and `BODY_FREE_WALL_GUARD_MS` of wall time); a
 * death ends it at once. `sleep` is the driver clock's wait (a test's fake clock).
 */
export async function waitUntilBodyFree(context: ScenarioContext, since: BurnStart, sleep: (ms: number) => Promise<void> = delay): Promise<BodyFreeWait> {
  const { bot } = context;
  const began = monotonicNow();
  const owners: string[] = [];
  let fireOutAfterTicks: number | null = null;
  for (;;) {
    const owner = await readActiveOwner(context);
    if (owner !== undefined && owner !== null && !owners.includes(owner)) owners.push(owner);
    const burning = isBurning(bot);
    const now = monotonicNow();
    const afterStartTicks = bot.time.age - since.age;
    if (!burning && fireOutAfterTicks === null) fireOutAfterTicks = afterStartTicks;
    const ended = { waitedMs: Math.round(now - began), afterStartTicks, fireOutAfterTicks, burning, owners };
    if (bot.health <= 0) return { freed: false, reason: "the bot died while the wait ran", ...ended };
    if (!burning && owner === undefined) return { freed: true, reason: "free", ...ended };
    if (afterStartTicks >= BODY_FREE_BOUND_TICKS) return { freed: false, reason: describeBlocked(burning, owners, owner, `${afterStartTicks} ticks`), ...ended };
    if (now - since.atMs >= BODY_FREE_WALL_GUARD_MS) return { freed: false, reason: describeBlocked(burning, owners, owner, `${Math.round(now - since.atMs)} ms of wall time (the world age moved ${afterStartTicks} ticks: the server may have stopped)`), ...ended };
    await sleep(POLL_MS);
  }
}

/** What kept the body from being free at the bound, for the completion detail. */
function describeBlocked(burning: boolean, owners: readonly string[], owner: string | undefined | null, after: string): string {
  const holdingNow = owner === null ? "its status call did not answer" : owner === undefined ? "no action holds it" : `${owner} holds it`;
  return `${after} after the start the body is ${burning ? "still burning" : "not burning"} and ${holdingNow} (held by ${owners.join(", ") || "no action"} while it waited)`;
}
