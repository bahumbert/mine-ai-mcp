/**
 * What the server keeps of every mob species of the registry, measured with commands and equal to `src/world/data/combat-data/<version>.json`
 * (`mobs`, `varies`, `skipped`), the numbers the runtime's threat assessment reads (plan 2026-11-07-p4-06a-threat T1a).
 *
 * Measured 2026-11-07, 1.21.4 (probe, 2 runs): `/summon <id>` with no other data runs `finalizeSpawn` (a slime's size and a horse's genes are
 * random; with any NBT in the command they are not), so each species is summoned with the id alone, then `/data merge entity` makes it
 * `NoAI` (the same tick, so it never acts), persistent and tagged. `attribute <target> <id> base get` leaves out equipment and effects.
 * Attribute ids are `max_health`... in 1.21.4 (`generic.max_health` before 1.21.2): minecraft-data has no attribute list for this version,
 * so the ids are named here and the first read fails the check if the server does not know them.
 */
import assert from "node:assert/strict";
import type { CombatDataFile, MeasuredMob, MeasuredPart } from "../../../../src/world/combat-data-file.ts";
import { uniteMobs } from "../../../../src/world/combat-data-write.ts";
import type { ContractCheck } from "../checks.ts";
import { type MeasureReader, type Reading, attributeCommand, attributeOf, createMeasureReader, failWithMeasured, shippedCombatData } from "./combat-data-measure.ts";
import { NIGHT } from "./combat-scene.ts";
import type { ContractSubject } from "../subject.ts";

/** The attribute ids of the fields a mob's file entry holds. */
const ATTRIBUTE_IDS = {
  maxHealth: "max_health",
  attackDamage: "attack_damage",
  armor: "armor",
  armorToughness: "armor_toughness",
  movementSpeed: "movement_speed",
  followRange: "follow_range",
} as const;
type AttributeField = keyof typeof ATTRIBUTE_IDS;

/**
 * Where the copies of a species stand, in arena-local blocks from the bot: apart, so no body touches another. A field that differs among
 * them varies; three copies, because a slime's size is one of three and two copies agree a third of the time.
 */
const COPY_PLACES: readonly (readonly [number, number])[] = [[3.5, 3.5], [-3.5, 3.5], [3.5, -3.5]];
/** How far from the arena's middle a command looks for the mobs it removes (the arena is 12 wide). */
const ARENA_REACH = 15;
/** Removal passes before the check fails (a rider or a passenger spawned with a mob goes with the next pass). */
const CLEAR_PASSES = 4;
/** The registry category suffix of the mob categories (`Hostile mobs`, `Passive mobs`), the field `isHostileSpecies` reads. */
const MOB_CATEGORY_SUFFIX = "mobs";

const nbtCommand = (target: string, key: string) => `run data get entity ${target} ${key}`;

/** One copy's reads, in the order of `readCommands`. */
function readCommands(target: string): string[] {
  return [
    `if entity ${target}`,
    ...Object.values(ATTRIBUTE_IDS).map((id) => attributeCommand(target, id, "base")),
    nbtCommand(target, "ExplosionRadius"),
    nbtCommand(target, "Fuse"),
    nbtCommand(target, "ExplosionPower"),
  ];
}

/** The reads of one copy: its presence, the six attributes, the three NBT keys. */
const ATTRIBUTE_COUNT = Object.keys(ATTRIBUTE_IDS).length;
const READS_PER_COPY = 1 + ATTRIBUTE_COUNT + 3;

/** The file entry a copy's readings give; null when the entity has no health (not a living entity: it has no combat numbers). */
function mobFrom(readings: readonly Reading[]): MeasuredMob | null {
  const [, ...rest] = readings;
  const attributes = rest.slice(0, ATTRIBUTE_COUNT);
  if (!attributes[0]!.present) return null;
  const [radius, fuse, power] = rest.slice(ATTRIBUTE_COUNT) as [Reading, Reading, Reading];
  const field = (name: AttributeField) => attributeOf(attributes[Object.keys(ATTRIBUTE_IDS).indexOf(name)]!);
  return {
    maxHealth: field("maxHealth"),
    attackDamage: field("attackDamage"),
    armor: field("armor"),
    armorToughness: field("armorToughness"),
    movementSpeed: field("movementSpeed"),
    followRange: field("followRange"),
    explosion: radius.present && fuse.present ? { radius: radius.raw, fuseTicks: fuse.raw } : null,
    rangedExplosionPower: power.present ? power.raw : null,
  };
}

/** The selector of everything but players within `ARENA_REACH` of the middle of this subject's arena. */
function arenaMobs(subject: ContractSubject): string {
  const middle = subject.world([0, -60, 0]);
  return `@e[type=!player,x=${middle.x},y=${middle.y},z=${middle.z},distance=..${ARENA_REACH}]`;
}

/** Every mob in the arena goes to the void (a rider, an item a mob dropped too); resolves once none stands within reach. */
async function clearArena(subject: ContractSubject, reader: MeasureReader, species: string): Promise<void> {
  const around = arenaMobs(subject);
  for (let pass = 0; pass < CLEAR_PASSES; pass += 1) {
    reader.send(`execute as ${around} at @s run tp @s ~ -400 ~`);
    const [left] = await reader.read([`if entity ${around}`]);
    if (!left!.present) return;
  }
  assert.fail(`${species}: mobs still stand in the arena after ${CLEAR_PASSES} removal passes`);
}

/** Summon a copy of `species` at each of `COPY_PLACES`, read each, remove them all; the file entry (varying fields null) with the fields that varied, or null when the species cannot be read. */
async function measureSpecies(subject: ContractSubject, reader: MeasureReader, species: string, tagPrefix: string): Promise<{ mob: MeasuredMob; varying: string[] } | null> {
  COPY_PLACES.forEach(([x, z], copy) => {
    const place = subject.world([x, -60, z]);
    reader.send(`summon ${species} ${place.x} ${place.y} ${place.z}`);
    reader.send(`data merge entity @e[type=${species},x=${place.x},y=${place.y},z=${place.z},distance=..2,limit=1,sort=nearest] {NoAI:1b,Silent:1b,PersistenceRequired:1b,Tags:["${tagPrefix}${copy}"]}`);
  });
  const readings = await reader.read(COPY_PLACES.flatMap((_, copy) => readCommands(`@e[tag=${tagPrefix}${copy},limit=1]`)));
  await clearArena(subject, reader, species);
  const perCopy = COPY_PLACES.map((_, copy) => readings.slice(copy * READS_PER_COPY, (copy + 1) * READS_PER_COPY));
  const found = perCopy.filter(([exists]) => exists!.present).length;
  if (found === 0) return null;
  assert.equal(found, COPY_PLACES.length, `${species}: only ${found} of ${COPY_PLACES.length} copies were found by their tag after /summon and /data merge`);
  const copies = perCopy.map(mobFrom);
  if (copies.some((copy) => copy === null)) return null;
  const into: Record<string, MeasuredMob> = {};
  const varies: Record<string, Set<string>> = {};
  for (const copy of copies) uniteMobs(into, varies, { [species]: copy! });
  return { mob: into[species]!, varying: [...(varies[species] ?? [])] };
}

/** The differences between the measured part and the shipped file, as short sentences; none when the file holds exactly what was measured (fields that vary excluded). */
function differencesFrom(measured: Required<Pick<MeasuredPart, "mobs" | "skipped">>, shipped: CombatDataFile): string[] {
  const differences: string[] = [];
  const names = new Set([...Object.keys(measured.mobs), ...Object.keys(shipped.mobs)]);
  for (const name of [...names].sort()) {
    const measuredMob = measured.mobs[name];
    const shippedMob = shipped.mobs[name];
    if (measuredMob === undefined || shippedMob === undefined) {
      differences.push(`${name} ${measuredMob === undefined ? "is only in the file" : "is not in the file"}`);
      continue;
    }
    const now: Readonly<Record<string, unknown>> = { ...measuredMob };
    const then: Readonly<Record<string, unknown>> = { ...shippedMob };
    const skip = new Set(shipped.varies[name] ?? []);
    for (const key of Object.keys(then).filter((field) => !skip.has(field))) {
      if (JSON.stringify(now[key]) !== JSON.stringify(then[key])) differences.push(`${name}.${key} ${JSON.stringify(now[key])} against ${JSON.stringify(then[key])}`);
    }
  }
  if (JSON.stringify([...measured.skipped].sort()) !== JSON.stringify(shipped.skipped)) differences.push(`skipped ${measured.skipped.join(",")} against ${shipped.skipped.join(",")}`);
  return differences;
}

export const combatDataMobs: ContractCheck = {
  name: "combat-data-mobs",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5], timeOfDay: NIGHT, difficulty: "easy" },
  withoutRuntime: true,
  waitsForFake: "the fake has no server to read mob attributes from: its numbers come from this check's shipped file once a fake reads it (plan 2026-11-07-p4-06a-threat, master orders it after P4-03 T1)",
  async run(subject) {
    const { bot } = subject;
    const reader = createMeasureReader(subject);
    const [ownHealth] = await reader.read([attributeCommand("@s", ATTRIBUTE_IDS.maxHealth, "base")]);
    assert.ok(ownHealth!.present, `the server does not know the attribute '${ATTRIBUTE_IDS.maxHealth}': ids before 1.21.2 are 'generic.'-prefixed (server ${bot.version})`);
    const species = bot.registry.entitiesArray.filter(({ category }) => category?.endsWith(MOB_CATEGORY_SUFFIX) === true).map(({ name }) => name).sort();
    assert.ok(species.length > 0, "the registry lists no mob category");
    await clearArena(subject, reader, "before the first species");
    const mobs: Record<string, MeasuredMob> = {};
    const varies: Record<string, string[]> = {};
    const skipped: string[] = [];
    try {
      for (const [index, name] of species.entries()) {
        const measured = await measureSpecies(subject, reader, name, `cdm_${bot.username}_${index}_`);
        if (measured === null) skipped.push(name);
        else {
          mobs[name] = measured.mob;
          if (measured.varying.length > 0) varies[name] = measured.varying.sort();
        }
      }
    } finally {
      // A failed read or removal leaves up to three persistent NoAI mobs (a wither, a dragon) in the lane: send the removal once more, not awaited.
      reader.send(`execute as ${arenaMobs(subject)} at @s run tp @s ~ -400 ~`);
    }
    const part: MeasuredPart = { mobs, varies, skipped };
    const shipped = shippedCombatData(bot.version);
    if (shipped === null) failWithMeasured(part, []);
    const differences = differencesFrom({ mobs, skipped }, shipped);
    if (differences.length > 0) failWithMeasured(part, differences);
    return `${Object.keys(mobs).length} mobs equal the shipped file, ${skipped.length} skipped, ${Object.keys(varies).length} varying`;
  },
};
