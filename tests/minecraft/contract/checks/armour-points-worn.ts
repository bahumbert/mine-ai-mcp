/**
 * The armour points the client holds for its own body: the armour and armour toughness attributes of `bot.entity.attributes` (base value and
 * modifiers as the server sends them on an equip and an unequip, `entities.js` `updateAttributes`), combined with the operations of
 * `mineflayer/lib/plugins/explosion.js:40-56`. An iron chestplate on the torso is 6 points and no toughness, a diamond one 8 and 2 (vanilla); with
 * nothing worn the points are 0. Then the body is killed and respawned: the check records what the attribute reads after the new life.
 *
 * Measured on the real 1.21.4 server through Mine Labs, 2026-11-07 (plan 2026-11-07-p4-03-condition-line, task 1), the shared scenario server:
 * - Mineflayer files the own entity's attributes under `generic.armor` and `generic.armor_toughness` (`bot.entity.attributes[key] = { value, modifiers }`).
 * (The check asserts the points 6/0, 8/2, 0/0, 6/0; the key names, the modifier's uuid and operation and the respawn readings below are written in its note, read in the run, not asserted.)
 * - Base value 0 on both; a worn piece adds one modifier `{ uuid: "minecraft:armor.chestplate", amount: 6, operation: 0 }` (iron: armor 6; diamond: armor 8 and
 *   a toughness modifier 2); an unequip removes it, so the points read 0 and 0 (the attribute key stays, with no modifier). Each change is told within the
 *   server's ticks of the equip packet (waited for with `answerArrives`, never a sleep).
 * - After `/kill` and the client's own respawn (the template keeps the inventory: the chestplate stays on the torso) 2 attribute updates of her own
 *   entity came, and the attribute read 6 and 0 again: with the gear kept, the points are kept. A death that drops the gear (keepInventory off) is not
 *   measured: the rule it would set is the runtime's (`armourPoints` reads the worn slots first, so a stale attribute never gives points for an empty slot).
 */
import type { ContractBot } from "../subject.ts";
import type { ContractCheck } from "../checks.ts";
import { answerArrives } from "../server-answer.ts";
import { recordDeath, untilPhysicsAgain } from "./respawn-scene.ts";

const ARMOUR_KEY_PART = "armor";
const TOUGHNESS_KEY_PART = "toughness";

interface Attribute {
  readonly value: number;
  readonly modifiers: readonly { readonly amount: number; readonly operation: unknown }[];
}

/** The attribute the own entity holds under a key that names `part` (the key text is recorded in the note), with that key. */
function attributeNamed(bot: ContractBot, part: string): { readonly key: string; readonly attribute: Attribute } | null {
  const attributes = (bot.entity as unknown as { attributes?: Record<string, Attribute> }).attributes ?? {};
  const keys = Object.keys(attributes).filter((key) => key.includes(part) && (part !== ARMOUR_KEY_PART || !key.includes(TOUGHNESS_KEY_PART)));
  return keys.length === 0 ? null : { key: keys[0]!, attribute: attributes[keys[0]!]! };
}

/** The operations of `explosion.js:40-56`: 0 adds to the value, 1 adds a share of that sum to the result, 2 adds a share of the result. */
function valueOf({ value, modifiers }: Attribute): number {
  const isOperation = (modifier: Attribute["modifiers"][number], operation: number) => modifier.operation === operation;
  let base = value;
  for (const modifier of modifiers) if (isOperation(modifier, 0)) base += modifier.amount;
  let result = base;
  for (const modifier of modifiers) if (isOperation(modifier, 1)) result += base * modifier.amount;
  for (const modifier of modifiers) if (isOperation(modifier, 2)) result += result * modifier.amount;
  return result;
}

const pointsOf = (bot: ContractBot) => {
  const armor = attributeNamed(bot, ARMOUR_KEY_PART);
  const toughness = attributeNamed(bot, TOUGHNESS_KEY_PART);
  return { armor: armor && valueOf(armor.attribute), toughness: toughness && valueOf(toughness.attribute) };
};

export const armourPointsWorn: ContractCheck = {
  name: "armour-points-worn",
  // Our runtime would act on the death: the check reads the bare client.
  withoutRuntime: true,
  fixture: { cells: {}, carried: { iron_chestplate: 1, diamond_chestplate: 1 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const item = (name: string) => bot.inventory.items().find((stack) => stack.name === name)!;
    const notes: string[] = [];
    const wearsPoints = async (armor: number, toughness: number, what: string) => {
      await answerArrives(subject, () => {
        const points = pointsOf(bot);
        return points.armor === armor && points.toughness === toughness;
      }, `${what}: the attributes never read ${armor}/${toughness}`, () => JSON.stringify(pointsOf(bot)));
      notes.push(`${what}: ${armor}/${toughness}`);
    };
    await bot.equip(item("iron_chestplate"), "torso");
    await wearsPoints(6, 0, "iron chestplate");
    await bot.equip(item("diamond_chestplate"), "torso");
    await wearsPoints(8, 2, "diamond chestplate");
    await bot.unequip("torso");
    await wearsPoints(0, 0, "nothing worn");
    await bot.equip(item("iron_chestplate"), "torso");
    await wearsPoints(6, 0, "iron chestplate again");
    const keys = `keys ${attributeNamed(bot, ARMOUR_KEY_PART)?.key}, ${attributeNamed(bot, TOUGHNESS_KEY_PART)?.key}`;
    const recorded = recordDeath(subject);
    let updatesAfterDeath = 0;
    const countUpdate = (entity: { readonly id: number }) => {
      if (entity.id === bot.entity.id) updatesAfterDeath += 1;
    };
    bot.on("entityAttributes", countUpdate);
    try {
      await subject.killBot();
      await answerArrives(subject, () => recorded.heard.some(({ name }) => name === "update_health:20"), "no update_health at full health after the death");
      await untilPhysicsAgain(subject, recorded.heard);
    } finally {
      recorded.stop();
      bot.off("entityAttributes", countUpdate);
    }
    const worn = bot.inventory.slots[bot.getEquipmentDestSlot("torso")]?.name ?? null;
    notes.push(`after death and respawn (${updatesAfterDeath} attribute updates of her own entity heard since the kill): torso ${worn}, attribute ${JSON.stringify(pointsOf(bot))}, modifiers ${JSON.stringify(attributeNamed(bot, ARMOUR_KEY_PART)?.attribute)}`);
    return `${keys}; ${notes.join("; ")}`;
  },
};
