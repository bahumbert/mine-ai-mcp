// A close intruder cannot prevent the shelter's next wall from being built.
import type { Bot } from "mineflayer";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { Vec3 } from "vec3";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { observeIdleWindow } from "./idle-reflex-window.ts";

/** Observe the existing frozen-intruder fixture before starting the measured hide. */
async function arrangeHideIntruder(bot: Bot, neutral: boolean, signal: AbortSignal) {
  const species = neutral ? "piglin" : "wither_skeleton";
  for (const [name, slot] of [
    ["iron_helmet", "head"],
    ["iron_chestplate", "torso"],
    ["iron_leggings", "legs"],
    ["golden_boots", "feet"],
    ["shield", "off-hand"],
  ] as const) {
    const item = bot.inventory.items().find((item) => item.name === name);
    if (!item) throw new Error(`Missing ${name}`);
    await bot.equip(item, slot);
  }
  // The attacker stays frozen inside the shelter shell: freed, it is pushed out of the shell within three ticks and
  // circles the walls, so whether the bot gets a swing in before the box closes was the mob's timing (2026-10-20).
  const equipment = neutral ? "" : ',HandItems:[{id:"minecraft:stone_sword",count:1},{}]';
  bot.chat(`/summon minecraft:${species} 0.5 -60 -0.1 {NoAI:1b,PersistenceRequired:1b${equipment}}`);
  await bot.waitForTicks(10);
  bot.chat("/damage @s 12.4 minecraft:magic");
  await observeIdleWindow(bot, 20, () => bot.health <= 8, signal);
  const mob = bot.nearestEntity((entity) => entity.name === species);
  if (!mob || bot.health > 8) throw new Error("Low-health intruder arrangement was not observed");
  const observedWeapon = mob.equipment[0]?.name ?? null;
  if (!neutral && observedWeapon !== "stone_sword")
    throw new Error(`Attacker stone sword not observed: ${observedWeapon}`);
  return { mob, observedWeapon };
}

/** The missing wall cells and cap in the enclosure the hide actually built. */
function openShelterCells(bot: Bot): Vec3[] {
  const feet = bot.entity.position.floored();
  const cells = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    .flatMap((side) => [feet.plus(side), feet.plus(side).offset(0, 1, 0)])
    .concat(feet.offset(0, 2, 0));
  return cells.filter((cell) => bot.blockAt(cell)?.boundingBox !== "block");
}

export const run: MineAiScenario = async ({ bot, navigation, scenario, signal, log }) => {
  const neutral = scenario.name?.endsWith("neutral") ?? false;
  const { mob, observedWeapon } = await arrangeHideIntruder(bot, neutral, signal);
  log(JSON.stringify({ kind: "arranged", mobId: mob.id, observedWeapon, health: bot.health }));
  const started = monotonicNow();
  const abort = new AbortController();
  let died = false;
  let attacks = 0;
  let intruderDied = false;
  let placedBeforeIntruderDied = false;
  const onEntityDead = (entity: typeof mob) => { if (entity.id === mob.id) intruderDied = true; };
  bot.on("entityDead", onEntityDead);
  const write = bot._client.write;
  bot._client.write = function (name, data) {
    if (name === "block_place" && bot.heldItem?.name === "cobblestone" && attacks > 0 && !intruderDied)
      placedBeforeIntruderDied = true;
    if (name === "block_place" || name === "held_item_slot")
      log(JSON.stringify({
        kind: name, ms: monotonicNow() - started, data,
        held: bot.heldItem?.name, count: bot.heldItem?.count, quickBarSlot: bot.quickBarSlot,
        bot: bot.entity.position, mob: mob.position,
      }));
    return write.call(bot._client, name, data);
  };
  const attack = bot.attack;
  bot.attack = function (entity, ...args) {
    attacks++;
    return attack.call(bot, entity, ...args);
  };
  const onDeath = () => {
    died = true;
    abort.abort(new Error("fixture death"));
  };
  bot.on("death", onDeath);
  try {
    using responseOwner1 = new ScenarioCombat(bot, navigation);
    const result = await responseOwner1.hide(bot, {
      signal: AbortSignal.any([signal, abort.signal]),
      recoverTo: 18,
      // The whole hide, repelling included, must fit (construction ends at this budget).
      maximumMs: 12_000,
    });
    const openCells = openShelterCells(bot);
    await observeIdleWindow(bot, 80, () => died, signal);
    const passed =
      !died &&
      (neutral
        ? attacks === 0 &&
          result.kind === "failed" &&
          /still open.*overlaps piglin/.test(result.error ?? "") &&
          [new Vec3(0, -60, -1), new Vec3(0, -59, -1)].every((cell) => openCells.some((open) => open.equals(cell)))
        : attacks > 0 && placedBeforeIntruderDied && result.kind !== "failed" && openCells.length === 0);
    const evidence = {
      observedWeapon,
      result,
      died,
      attacks,
      placedBeforeIntruderDied,
      health: bot.health,
      openCells,
      durationMs: monotonicNow() - started,
    };
    log(JSON.stringify(evidence));
    return { status: passed ? "succeeded" : "failed", detail: JSON.stringify(evidence) };
  } finally {
    bot._client.write = write;
    bot.attack = attack;
    bot.off("death", onDeath);
    bot.off("entityDead", onEntityDead);
  }
};
