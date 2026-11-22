/**
 * What the server's player attributes become with each registry item in the main hand, measured with commands and equal to
 * `src/world/data/combat-data/<version>.json` (`bareHand`, `items`), the weapon numbers the runtime's threat assessment reads
 * (plan 2026-11-07-p4-06a-threat T1a). One check per chunk of the registry, so each stays inside a scenario's time.
 *
 * Measured 2026-11-07, 1.21.4 (probe): `/item replace entity @s weapon.mainhand with <item>` changes the item at once but the player's
 * attributes follow on the entity's next tick (a read in the same tick still gave the old item's damage: 6 for the iron sword just
 * replaced by a diamond axe; 9 after 4 ticks), so each read waits two ticks of the server's own game time. `get` (not `base get`)
 * is the attribute with the held item's modifiers.
 */
import assert from "node:assert/strict";
import minecraftData from "minecraft-data";
import { DEFAULT_MINECRAFT_VERSION } from "../../../../src/server/config.ts";
import type { CombatDataFile, MeasuredItemAttack, MeasuredPart } from "../../../../src/world/combat-data-file.ts";
import type { ContractCheck } from "../checks.ts";
import type { ContractSubject } from "../subject.ts";
import { type MeasureReader, afterGameTicks, attributeCommand, attributeOf, createMeasureReader, failWithMeasured, shippedCombatData } from "./combat-data-measure.ts";

/** Registry items measured per check: ~100 ms each (two ticks), so a chunk takes well under the 90 s a scenario has. */
const ITEMS_PER_CHECK = 250;
/** Server ticks that pass after an item replace before its attributes are read. */
const TICKS_BEFORE_READ = 2;

/** The item numbers of every chunk of the registry of `DEFAULT_MINECRAFT_VERSION`, one check each. */
function chunkChecks(): ContractCheck[] {
  const count = minecraftData(DEFAULT_MINECRAFT_VERSION).itemsArray.length;
  return Array.from({ length: Math.ceil(count / ITEMS_PER_CHECK) }, (_, chunk) => chunkCheck(chunk));
}

function chunkCheck(chunk: number): ContractCheck {
  return {
    name: `combat-data-items-${chunk + 1}`,
    fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5] },
    withoutRuntime: true,
    waitsForFake: "the fake has no server to read item attributes from: its numbers come from this check's shipped file once a fake reads it (plan 2026-11-07-p4-06a-threat, master orders it after P4-03 T1)",
    async run(subject) {
      const { bot } = subject;
      const reader = createMeasureReader(subject);
      const names = bot.registry.itemsArray.slice(chunk * ITEMS_PER_CHECK, (chunk + 1) * ITEMS_PER_CHECK).map(({ name }) => name).filter((name) => name !== "air");
      let part: MeasuredPart;
      try {
        part = await measureChunk(subject, reader, names);
      } finally {
        reader.send(`item replace entity @s weapon.mainhand with minecraft:${EMPTY_HAND}`);
      }
      const shipped = shippedCombatData(bot.version);
      if (shipped === null) failWithMeasured(part, []);
      const differences = differencesFrom(part, names, shipped);
      if (differences.length > 0) failWithMeasured(part, differences);
      return `${names.length} items, ${Object.keys(part.items!).length} differ from the bare hand, equal to the shipped file`;
    },
  };
}

/** The item that leaves the main hand empty. */
const EMPTY_HAND = "air";

/** Puts `item` in the main hand (`EMPTY_HAND`: empty), waits for the entity's tick, reads the attack; null when the hand does not hold it. */
async function attackWith(subject: ContractSubject, reader: MeasureReader, item: string): Promise<MeasuredItemAttack | null> {
  reader.send(`item replace entity @s weapon.mainhand with minecraft:${item}`);
  await afterGameTicks(subject, await subject.serverGameTime(), TICKS_BEFORE_READ);
  const [damage, speed, held] = await reader.read([
    attributeCommand("@s", "attack_damage", "total"),
    attributeCommand("@s", "attack_speed", "total"),
    item === EMPTY_HAND ? "if entity @s" : `if items entity @s weapon.mainhand minecraft:${item}`,
  ]);
  const attackDamage = attributeOf(damage!);
  const attackSpeed = attributeOf(speed!);
  return held!.present && attackDamage !== null && attackSpeed !== null ? { attackDamage, attackSpeed } : null;
}

/** The bare hand's attack and, of `names`, the items whose attack differs from it. */
async function measureChunk(subject: ContractSubject, reader: MeasureReader, names: readonly string[]): Promise<MeasuredPart> {
  const bareHand = await attackWith(subject, reader, EMPTY_HAND);
  assert.ok(bareHand !== null, "the empty main hand gave no attack_damage and attack_speed (is the bot op? are the attribute ids 1.21.2 ones?)");
  const items: Record<string, MeasuredItemAttack> = {};
  for (const name of names) {
    const attack = await attackWith(subject, reader, name);
    assert.ok(attack !== null, `${name}: the main hand did not hold it after /item replace, or an attack attribute was missing`);
    if (attack.attackDamage !== bareHand.attackDamage || attack.attackSpeed !== bareHand.attackSpeed) items[name] = attack;
  }
  return { bareHand, items };
}

/** The differences between this chunk's measurement and the shipped file's part for the same items. */
function differencesFrom(part: MeasuredPart, chunkNames: readonly string[], shipped: CombatDataFile): string[] {
  const differences: string[] = [];
  if (JSON.stringify(part.bareHand) !== JSON.stringify(shipped.bareHand)) differences.push(`bare hand ${JSON.stringify(part.bareHand)} against ${JSON.stringify(shipped.bareHand)}`);
  for (const name of chunkNames) {
    const now = part.items![name];
    const then = shipped.items[name];
    if (JSON.stringify(now) !== JSON.stringify(then)) differences.push(`${name} ${JSON.stringify(now)} against ${JSON.stringify(then)}`);
  }
  return differences;
}

export const COMBAT_DATA_ITEM_CHECKS: readonly ContractCheck[] = chunkChecks();
