// Passive quarry and imminent hostile contacts share the real approach stance checks.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { flatWorld, observation } from "../../../test-support/navigation.js";
import { meleeApproachGoal, meleeStanceSafe } from "../../weapons/melee.js";
import { meleeAttackers, meleeStanceKey } from "./melee-stance.js";
import type { FightScene } from "./scene.js";
import { FightWeapons } from "./weapons.js";

test("passive quarry and defenders do not reject a lip-side stance; hostile contacts still do", () => {
  for (const { target, defender, imminent, safe, approachSafe } of [
    { target: "cow", defender: "cow", imminent: false, safe: true, approachSafe: true },
    { target: "zombie", defender: "cow", imminent: false, safe: false, approachSafe: false },
    { target: "cow", defender: "zombie", imminent: false, safe: false, approachSafe: true },
    { target: "cow", defender: "cow", imminent: true, safe: false, approachSafe: false },
  ]) {
    const { bot } = createFakeBot({
      position: new Vec3(0.5, 63, 0.5),
      entities: {
        7: { name: target, position: new Vec3(0.5, 63, 2.5) },
        8: { name: defender, position: new Vec3(0.5, 63, 2.5) },
        9: { name: "zombie", position: new Vec3(0.5, 63, 2.5) },
      },
    });
    const world = flatWorld();
    world.load({ x: 0, y: 63, z: -1 }, { stateId: 1 });
    const scene = {
      bot, target: bot.entities[7]!, navigation: { world },
      perception: { read: () => imminent ? [{ id: 9, meleeImminent: true }] : [] },
    } as unknown as FightScene;
    const label = JSON.stringify({ target, defender, imminent });
    assert.equal(meleeStanceSafe(world, bot.entity.position, meleeAttackers(scene, bot.entities[8]!), bot.health), safe, label);
    const goal = meleeApproachGoal(bot, 7, world, () => meleeAttackers(scene)).resolve({
      ...observation(), position: bot.entity.position, stance: "supported",
    });
    assert.equal(goal.kind, "active");
    if (goal.kind !== "active") continue;
    assert.equal(goal.isSatisfied({ feet: { x: 0, y: 63, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" }, world), approachSafe, label);
    const key = meleeStanceKey(scene, bot.entities[8]!);
    bot.entities[8]!.position.z++;
    assert.equal(meleeStanceKey(scene, bot.entities[8]!) === key, defender === "cow", label);
  }
});

/** A position on the bot's row (z 0.5): the bot's feet are at (0.5, 63, 0.5), on flat ground at y 62. */
const at = (x: number, z = 0.5) => new Vec3(x, 63, z);

/** A mob beside the target. `state` is how the fight already knows it: `dead` (scene.dead) or `resolved` (perception.resolvedIds). */
type Contact = { name: string; position: Vec3; state?: "live" | "dead" | "resolved" };
const creeper = (x: number, state?: Contact["state"]): Contact => ({ name: "creeper", position: at(x), state });

/**
 * A bow fight: the target is a creeper at `target`; `contacts` are the other mobs (ids 8, 9, ...). The loadout is read from the
 * real `FightWeapons.currentLoadout`; the shared fake's bot carries a sword, a bow and arrows unless `arrows` is false, and the
 * policy allows the bow unless `bow` is false. A dead and a resolved contact are kept in separate sets, so each exclusion is tested alone.
 */
function bowFight(options: { ticksPerSecond: number; target: Vec3; contacts?: readonly Contact[]; arrows?: boolean; bow?: boolean }) {
  const entities: Record<number, { name: string; position: Vec3; metadata: [] }> = {
    7: { name: "creeper", position: options.target, metadata: [] },
  };
  const dead = new Set<number>(), resolved = new Set<number>();
  (options.contacts ?? []).forEach((contact, index) => {
    const id = 8 + index;
    entities[id] = { name: contact.name, position: contact.position, metadata: [] };
    if (contact.state === "dead") dead.add(id);
    if (contact.state === "resolved") resolved.add(id);
  });
  const { bot } = createFakeBot({
    position: new Vec3(0.5, 63, 0.5),
    groundY: 62,
    server: { ticksPerSecond: options.ticksPerSecond },
    carried: options.arrows === false ? { diamond_sword: 1, bow: 1 } : { diamond_sword: 1, bow: 1, arrow: 3 },
    entities,
  });
  const scene = {
    bot, target: bot.entities[7]!, dead, movement: "pursue", position: { plan: null },
    signal: new AbortController().signal, navigation: { world: flatWorld() },
    perception: { read: () => [], resolvedIds: resolved, attackerIds: new Set<number>() },
    policy: { combat: { bow: options.bow ?? true, melee: true, shield: true } },
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  return { bot, neighbour: (index: number) => bot.entities[8 + index]!, loadout: () => weapons.currentLoadout().kind };
}

/** The bow rule's rows: the target's distance from the bot, the other mobs, the kit, and the loadout the fight takes. */
const ROWS: readonly { label: string; target: number; contacts?: readonly Contact[]; arrows?: boolean; bow?: boolean; expect: "bow" | "melee" }[] = [
  { label: "two creepers 4 blocks apart, the target 5 blocks away", target: 5.5, contacts: [creeper(9.5)], expect: "bow" },
  { label: "one creeper 5 blocks away", target: 5.5, expect: "melee" },
  { label: "two creepers, the target in reach (2.5 blocks)", target: 3.0, contacts: [creeper(7.0)], expect: "bow" },
  { label: "two creepers, no arrows", target: 5.5, contacts: [creeper(9.5)], arrows: false, expect: "melee" },
  { label: "two creepers, the bow forbidden", target: 5.5, contacts: [creeper(9.5)], bow: false, expect: "melee" },
  { label: "a zombie beside the target", target: 5.5, contacts: [{ name: "zombie", position: at(5.5, 1.5) }], expect: "melee" },
  { label: "a neighbour exactly 6 blocks from the target", target: 5.5, contacts: [creeper(11.5)], expect: "bow" },
  { label: "a neighbour 6.5 blocks from the target", target: 5.5, contacts: [creeper(12.0)], expect: "melee" },
  { label: "a dead neighbour within 6 blocks (scene.dead only)", target: 5.5, contacts: [creeper(9.5, "dead")], expect: "melee" },
  { label: "a resolved neighbour within 6 blocks (perception.resolvedIds only)", target: 5.5, contacts: [creeper(9.5, "resolved")], expect: "melee" },
];

for (const ticksPerSecond of [20, 10]) {
  const rate = `${ticksPerSecond} tps`;
  test(`a bow fight beside a second live explosive takes the bow; every other row takes the sword or stays bow-less (${rate})`, () => {
    for (const row of ROWS) {
      const loadout = bowFight({ ticksPerSecond, target: at(row.target), contacts: row.contacts, arrows: row.arrows, bow: row.bow }).loadout();
      assert.equal(loadout, row.expect, `${row.label} (${rate})`);
    }
  });
  test(`a neighbour that walks from 7 to 4 blocks of the target: the next turn takes the bow (${rate})`, () => {
    const fight = bowFight({ ticksPerSecond, target: at(5.5), contacts: [creeper(12.5)] });
    assert.equal(fight.loadout(), "melee");
    fight.neighbour(0).position.set(9.5, 63, 0.5);
    assert.equal(fight.loadout(), "bow");
  });
}
