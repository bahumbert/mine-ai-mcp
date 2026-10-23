// The bot, combat and navigation doubles the hunt_mob test files share (hunt-mob.test.ts, hunt-mob-pursuit.test.ts, hunt-mob-shield.test.ts).
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { type HuntTarget } from "../../navigation/processes/hunting/hunt-process.js";
import type { CombatController, CombatOutcome } from "../../survival/index.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { type FakeClock, type FakeEntitySpec, type FakeHarness, createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";
import { type HuntMobDependencies, type TargetEngagement } from "./hunt-mob.js";

type Entity = Parameters<Bot["attack"]>[0];

/** A mob or a dropped stack the harness puts in `bot.entities` under its id. */
export type EntitySpec = FakeEntitySpec & { readonly id: number; readonly position: Vec3 };

/**
 * The bot's combat, with its policy, fighting each engagement through `engage`: it stops at once, is never in the End,
 * finishes safe and clear at (0, 64, 0) and cannot recover on its own.
 */
export function engagingCombat(bot: Bot, engage: CombatController["engage"]): CombatController {
  return {
    resourceRefusal: () => null,
    policy: new SurvivalPolicyState(bot),
    runEnd: async () => {
      throw new Error("Unexpected End combat");
    },
    endDanger: () => false,
    activePosition: () => null,
    execution: () => null,
    onDecision: () => () => {},
    finish: async () => ({
      observedAt: 1,
      kind: "safe" as const,
      basis: "clear" as const,
      position: { x: 0, y: 64, z: 0 },
    }),
    canRecover: () => false,
    activeEngagement: () => null,
    stop: async () => {},
    engage,
  };
}

export function mob(id: number, entityType: number, name: string, x: number, kind = "Passive mobs"): EntitySpec {
  return { id, entityType, name, kind, position: new Vec3(x, 64, 0) };
}

/** The registry the dropped stacks are made from: the version's own, as every harness has it. */
const itemRegistry = createFakeBot().bot.registry;

/** A dropped stack of `count` `name` lying at `position`. */
export function droppedItem(id: number, name: string, count: number, position: Vec3): EntitySpec {
  return { id, name: "item", position, getDroppedItem: () => itemOf(itemRegistry, name, count) };
}

export const harnesses = new WeakMap<Bot, FakeHarness>();

/**
 * A harness bot at (0, 64, 0) that sees `targets`, carrying `inventory.count` of `dropName`: from here on
 * `inventory.count` reads and writes that count in the harness's inventory window, as the server's `set_slot` would.
 */
export function huntBot(
  targets: readonly EntitySpec[],
  inventory: { count: number },
  health = 20,
  { dropName = "white_wool", clock }: { dropName?: string; clock?: FakeClock } = {},
): Bot {
  const harness = createFakeBot({
    position: new Vec3(0, 64, 0),
    groundY: null,
    health,
    clock,
    entities: Object.fromEntries(targets.map((target) => [target.id, target])),
  });
  const drops = carriedCountField(harness, dropName);
  drops.count = inventory.count;
  Object.defineProperty(inventory, "count", {
    get: () => drops.count,
    set: (total: number) => void (drops.count = total),
    configurable: true,
  });
  harnesses.set(harness.bot, harness);
  return harness.bot;
}

/** Take an entity out of the bot's sight until the test lets it appear. */
export function unseen(bot: Bot, id: number): Entity {
  const entity = bot.entities[id]!;
  delete bot.entities[id];
  return entity;
}

/**
 * A pursuit that reaches every matching loaded mob in turn, nearest first.
 *
 * The walk itself is the hunt process's own subject, tested against a fake
 * route in `hunt-process.test.ts`. What these tests ask is what the action
 * makes of each thing the pursuit can report, so this stands in for the walk
 * and for nothing else.
 */
export function pursueLoaded(bot: Bot): HuntMobDependencies["pursue"] {
  return async (pursuit) => {
    const retired = new Set<number>();
    // The real process's rule: an unreachable fight is a stop on that target,
    // and a second stop gives it up.
    type Sighting = {
      readonly id: number;
      readonly position: { x: number; y: number; z: number };
      readonly distance: number;
    };
    const stops = new Map<number, number>();
    let lastStop: { readonly target: Sighting; readonly reason: string } | null = null;
    let previous: HuntTarget | null = null;
    let selectionReason = "Initial target selection.";
    const describe = (reason: string, target: Sighting) =>
      `${reason}; the target was last observed at ` +
      `${target.position.x},${target.position.y},${target.position.z}, ${target.distance.toFixed(1)} blocks away`;
    while (!pursuit.isSatisfied()) {
      const targets = Object.values(bot.entities)
        .filter((entity) => !retired.has(entity.id) && pursuit.matches(entity))
        .map((entity) => ({
          id: entity.id,
          position: {
            x: Math.floor(entity.position.x),
            y: Math.floor(entity.position.y),
            z: Math.floor(entity.position.z),
          },
          distance: entity.position.distanceTo(bot.entity.position),
        }))
        .sort((left, right) => left.distance - right.distance);
      await pursuit.onTargets?.(targets);
      const target = targets[0];
      if (!target) {
        return lastStop
          ? { status: "unreachable", reason: describe(lastStop.reason, lastStop.target) }
          : { status: "no_targets", reason: null };
      }
      if (previous?.id !== target.id)
        pursuit.onTargetChanged?.({ previous, selected: target, reason: selectionReason });
      previous = target;
      const refused = pursuit.preflight?.(bot.entities[target.id]!);
      if (refused) return { status: "capability_blocked", reason: describe(refused, target) };
      const engagement = await pursuit.engage(target.id);
      if (engagement.kind === "stopped") return { status: "stopped", reason: describe(engagement.reason, target) };
      if (engagement.kind === "unreachable") {
        const count = (stops.get(target.id) ?? 0) + 1;
        stops.set(target.id, count);
        lastStop = { target, reason: engagement.reason };
        selectionReason = engagement.reason;
        if (count >= 2) retired.add(target.id);
        continue;
      }
      retired.add(target.id);
      selectionReason =
        engagement.kind === "defeated" ? "The previous engagement was completed." : "The previous target was lost.";
    }
    return { status: "satisfied", reason: null };
  };
}

export function outcome(kind: CombatOutcome["kind"], attacks: number, extra: Partial<CombatOutcome> = {}): CombatOutcome {
  return {
    kind,
    targetId: 0,
    attacks,
    stylesUsed: ["melee"],
    weaponsUsed: ["iron_sword"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
    observation: "",
    ...extra,
  } as CombatOutcome;
}

export function died(attacks: number, x: number): TargetEngagement {
  return { outcome: outcome("died", attacks), deathPosition: { x, y: 64, z: 0 } };
}

export function dependencies(
  bot: Bot,
  inventory: { count: number },
  engagements: readonly TargetEngagement[],
  swept = 0,
): HuntMobDependencies {
  let engagementIndex = 0;
  return {
    createCamp: () => {
      throw new Error("Unexpected camping");
    },
    finish: fakeCombat.finish,
    pursue: pursueLoaded(bot),
    engageTarget: async () => {
      const result = engagements[engagementIndex];
      engagementIndex += 1;
      assert.ok(result);
      return result;
    },
    collectDropAfterDeath: async () => {
      inventory.count += 1;
      return { kind: "collected" };
    },
    sweepDropsAfterDeath: async () => swept,
    gatherLoadedDrops: async () => 0,
    shieldPermitted: () => true,
  };
}

export const fakeNavigation = { cancel: () => undefined } as unknown as NavigationRuntime;

export const fakeCombat = engagingCombat(createFakeBot().bot, async () => outcome("target_lost", 0));
