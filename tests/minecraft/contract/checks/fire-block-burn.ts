/**
 * How long a body burns after it stood in a fire block, a soul fire block, lava, or a shot's fire, and what a second contact does to it
 * (the residual burn `src/survival/perception/burn.ts` owes). Every case starts on a body that is not burning at full health, puts the
 * contact in the feet cell for a time (a brief one: the round trip of the command; a sustained one: 40 server ticks), then lets the
 * burn run out and reads the server's ticks, each asked when the client heard the event (`server-tick-marks.ts`), of: the end of each
 * contact (read right before the command that removed the block), the burning bit's clear (`shared_flags` bit 0) and each `on_fire` hurt.
 * The check returns them as its note: `F` (the fire block's burn) is the largest "ticks from the last fire contact to the clear" of the cases.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { answerArrives } from "../server-answer.ts";
import type { ContractSubject } from "../subject.ts";
import { STILL_MOB_NBT, NIGHT, burning, damageTypeId, mobAt } from "./combat-scene.ts";
import { logPackets } from "./packet-log.ts";
import { type Mark, markNow, restTicksSince, tickOf } from "./server-tick-marks.ts";

/** The body's feet cell and the floor under it, arena-local. */
const FEET: readonly [number, number, number] = [0, -60, 0];
const FLOOR: readonly [number, number, number] = [0, -61, 0];
/** The shooter stands this far west (a blaze with no AI, as `projectile-hit-bot`). */
const SHOOTER_X = -4.5;
/** A sustained contact and the gap between two contacts, in server ticks. */
const SUSTAINED_TICKS = 40;
/** A brief contact: the block stays one server tick (the first measuring runs left it for the command's round trip, 1 or 2 ticks). */
const BRIEF_TICKS = 1;
const GAP_TICKS = 40;
/** A shot-lit body takes its next contact this many ticks after the hit (the shot's fire lasts 100). */
const AFTER_SHOT_TICKS = 20;
/** The body is given this many ticks after the last contact before a burn is called absent or still running (the shortest burn is the 100 of a shot). */
const LOOK_TICKS = 30;
/** Health the body must have before a case, so a long burn never kills it. */
const HEALTHY = 19;
/** `restUntil` rests this many server ticks between two looks. */
const REST_STEP_TICKS = 20;
/** A burn is called not ending after this many ticks (the longest believed burn is lava's 300), and a heal after this many (1 hp a 10 ticks heals 19 in 190). */
const BURN_LIMIT_TICKS = 600;
const HEAL_LIMIT_TICKS = 400;

type Contact = "fire" | "soul_fire" | "lava";
type Step = { readonly contact: Contact; readonly ticks: number } | { readonly gap: number } | { readonly shot: true };

/**
 * What a case must show, as measured on the 1.21.4 server (2026-11-21, 5 runs at 20 and 5 at 10 tps) and as the fake answers: not lit, or lit and the
 * burning bit's clear a number of ticks from the last contact of a kind (`first`: from the first contact's end, for a shot).
 */
type Expect = { readonly lit: false } | { readonly lit: true; readonly after: "fire" | "lava" | "first"; readonly min: number; readonly max: number };
/** Lava: 301-303 read (300 owed); a fire or soul fire block: 161-176 read; a shot: 103 read from the end of the command (100 owed plus the flight). */
const LAVA_CLEAR: Expect = { lit: true, after: "lava", min: 297, max: 304 };
const FIRE_CLEAR: Expect = { lit: true, after: "fire", min: 150, max: 179 };
/** A fire block under a body that already burns adds a tick of burn per tick in it: lava, a 1-tick fire contact and its round trip cleared 305-307 ticks after the lava. */
const LAVA_PLUS_FIRE_CLEAR: Expect = { lit: true, after: "lava", min: 297, max: 312 };
const SHOT_CLEAR: Expect = { lit: true, after: "first", min: 100, max: 106 };
const NOT_LIT: Expect = { lit: false };

const CASES: readonly { readonly name: string; readonly steps: readonly Step[]; readonly expect: Expect }[] = [
  { name: "fire-brief", steps: [{ contact: "fire", ticks: BRIEF_TICKS }], expect: NOT_LIT },
  // 5 and 10 ticks lit nothing, 20 lit (5 runs at 20 tps).
  { name: "fire-5", steps: [{ contact: "fire", ticks: 5 }], expect: NOT_LIT },
  { name: "fire-10", steps: [{ contact: "fire", ticks: 10 }], expect: NOT_LIT },
  { name: "fire-20", steps: [{ contact: "fire", ticks: 20 }], expect: FIRE_CLEAR },
  { name: "fire-sustained", steps: [{ contact: "fire", ticks: SUSTAINED_TICKS }], expect: FIRE_CLEAR },
  { name: "soul-fire-brief", steps: [{ contact: "soul_fire", ticks: BRIEF_TICKS }], expect: NOT_LIT },
  { name: "soul-fire-sustained", steps: [{ contact: "soul_fire", ticks: SUSTAINED_TICKS }], expect: FIRE_CLEAR },
  { name: "lava-brief", steps: [{ contact: "lava", ticks: BRIEF_TICKS }], expect: LAVA_CLEAR },
  // A second contact never shortens the burn (lava's end stands after a fire block); a fire block under a burning body adds ticks.
  { name: "lava-then-fire", steps: [{ contact: "lava", ticks: BRIEF_TICKS }, { gap: GAP_TICKS }, { contact: "fire", ticks: BRIEF_TICKS }], expect: LAVA_PLUS_FIRE_CLEAR },
  { name: "fire-then-lava", steps: [{ contact: "fire", ticks: BRIEF_TICKS }, { gap: GAP_TICKS }, { contact: "lava", ticks: BRIEF_TICKS }], expect: LAVA_CLEAR },
  { name: "shot-then-fire", steps: [{ shot: true }, { gap: AFTER_SHOT_TICKS }, { contact: "fire", ticks: BRIEF_TICKS }], expect: SHOT_CLEAR },
];

/** One contact's end (or the shot), the kind and the server's tick read right before the command that removed the block. */
interface Contacted {
  readonly kind: Contact | "shot";
  readonly end: Mark;
}

/** What the client heard of the body's fire during one case. */
interface Watch {
  readonly contacts: Contacted[];
  ignited: boolean;
  cleared: Mark | null;
  readonly hurts: () => readonly Mark[];
  stop(): void;
}

/** Listen to the bot's burning bit and its `on_fire` hurts until `stop`. */
function watchBurn(subject: ContractSubject): Watch {
  const { bot } = subject;
  const log = logPackets(subject, ["damage_event"], ["damage_event"]);
  const onFire = damageTypeId(bot.registry, "on_fire");
  const watch: Watch = {
    contacts: [],
    ignited: false,
    cleared: null,
    hurts: () => log.packets.filter(({ packet }) => packet.entityId === bot.entity.id && packet.sourceTypeId === onFire).map(({ heardAt }) => heardAt!),
    stop: () => {
      bot.off("entityUpdate", onUpdate);
      log.stop();
    },
  };
  function onUpdate() {
    if (burning(bot)) {
      watch.ignited = true;
      watch.cleared = null;
    } else if (watch.ignited && watch.cleared === null) watch.cleared = markNow(subject);
  }
  bot.on("entityUpdate", onUpdate);
  return watch;
}

/** The body is out of fire at (nearly) full health: water at the feet puts a burn out, regeneration heals. */
async function calm(subject: ContractSubject): Promise<void> {
  const { bot } = subject;
  const feet = subject.world(FEET);
  // A body that died in an earlier case respawns elsewhere, and every later case would measure nothing (a fire-block case of 120 ticks, 2026-11-21).
  assert.ok(bot.entity.position.distanceTo(feet.offset(0.5, 0, 0.5)) < 2, `the body is not at the arena's feet cell any more (at ${bot.entity.position}, health ${bot.health}): it died in an earlier case`);
  if (burning(bot)) {
    await subject.setBlock(feet, "water");
    await answerArrives(subject, () => !burning(bot), "water did not put the burn out");
    await subject.setBlock(feet, "air");
  }
  // A long burn costs up to 15 hp and natural regeneration takes 80 ticks a hp (measured 2026-11-21: 10.8 hp left 400 ticks after a lava case): an instant heal.
  if (bot.health < HEALTHY) bot.chat("/effect give @s minecraft:instant_health 1 10 true");
  await restUntil(subject, () => bot.health >= HEALTHY && !burning(bot), HEAL_LIMIT_TICKS, `the body did not heal to ${HEALTHY}`, () => `health ${bot.health}, burning ${burning(bot)}`);
}

/** Rest server ticks, `REST_STEP_TICKS` at a time, until `done`; fails after `limitTicks` (a wait the server's ticks bound, never one that only the wall clock ends). */
async function restUntil(subject: ContractSubject, done: () => boolean, limitTicks: number, what: string, state: () => string): Promise<void> {
  for (let rested = 0; !done(); rested += REST_STEP_TICKS) {
    assert.ok(rested < limitTicks, `${what} within ${limitTicks} server ticks (${state()})`);
    await restTicksSince(subject, markNow(subject), REST_STEP_TICKS, what);
  }
}

/** One contact: the block in the feet cell for `ticks`, then air; the tick read right before the removal. */
async function touch(subject: ContractSubject, contact: Contact, ticks: number): Promise<Contacted> {
  const feet = subject.world(FEET);
  await subject.setBlock(feet, contact);
  if (ticks > 0) await restTicksSince(subject, markNow(subject), ticks, `${contact} for ${ticks} ticks`);
  const end = markNow(subject);
  await subject.setBlock(feet, "air");
  return { kind: contact, end };
}

async function runStep(subject: ContractSubject, step: Step, watch: Watch, shooterId: number): Promise<void> {
  if ("gap" in step) return restTicksSince(subject, markNow(subject), step.gap, `a gap of ${step.gap} ticks`);
  if ("shot" in step) {
    const end = markNow(subject);
    await subject.shootBot("small_fireball", shooterId);
    watch.contacts.push({ kind: "shot", end });
    return;
  }
  watch.contacts.push(await touch(subject, step.contact, step.ticks));
}

/** After the last contact: let the burn run out (or be seen absent) and return the server's ticks of each event, relative to the first contact's end. */
async function settle(subject: ContractSubject, watch: Watch): Promise<void> {
  const last = watch.contacts.at(-1)!;
  await restTicksSince(subject, last.end, LOOK_TICKS, "the look at the burn");
  if (burning(subject.bot)) await restUntil(subject, () => watch.cleared !== null, BURN_LIMIT_TICKS, "the burn did not end", () => `health ${subject.bot.health}`);
}

/** The case shows what it must (`Expect`): lit or not, and the clear's distance from the contact its kind counts from. */
function assertExpected(name: string, expect: Expect, shown: { readonly ignited: boolean; readonly cleared: number | null; readonly sinceFire: number | null; readonly sinceLava: number | null }): void {
  assert.equal(shown.ignited, expect.lit, `${name}: ${expect.lit ? "the body was not lit" : "the body was lit"}`);
  if (!expect.lit) return;
  const since = expect.after === "fire" ? shown.sinceFire : expect.after === "lava" ? shown.sinceLava : shown.cleared;
  assert.ok(since !== null && since >= expect.min && since <= expect.max, `${name}: the burning bit cleared ${since} ticks after the last ${expect.after} contact, not in ${expect.min}..${expect.max}`);
}

async function describeCase(subject: ContractSubject, name: string, expect: Expect, watch: Watch): Promise<string> {
  const origin = await tickOf(subject, watch.contacts[0]!.end);
  const contacts = await Promise.all(watch.contacts.map(async ({ kind, end }) => ({ kind, tick: (await tickOf(subject, end)) - origin })));
  const cleared = watch.cleared === null ? null : (await tickOf(subject, watch.cleared)) - origin;
  const hurts = await Promise.all(watch.hurts().map(async (mark) => (await tickOf(subject, mark)) - origin));
  const lastFire = contacts.filter(({ kind }) => kind === "fire" || kind === "soul_fire").at(-1);
  const lastLava = contacts.filter(({ kind }) => kind === "lava").at(-1);
  const sinceFire = lastFire === undefined || cleared === null ? null : cleared - lastFire.tick;
  const sinceLava = lastLava === undefined || cleared === null ? null : cleared - lastLava.tick;
  const note = `${name}: ignited ${watch.ignited}, contacts ${contacts.map(({ kind, tick }) => `${kind}@${tick}`).join(" ")}, cleared @${cleared}, from the last fire ${sinceFire}, from the last lava ${sinceLava}, ${hurts.length} on_fire hurts @${hurts.join(",")}`;
  assertExpected(name, expect, { ignited: watch.ignited, cleared, sinceFire, sinceLava });
  return note;
}

export const fireBlockBurn: ContractCheck = {
  name: "fire-block-burn",
  fixture: {
    cells: {},
    carried: {},
    position: [0.5, -60, 0.5],
    timeOfDay: NIGHT,
    difficulty: "easy",
    entities: [{ name: "blaze", position: [SHOOTER_X, -60, 0.5], nbt: STILL_MOB_NBT }],
  },
  withoutRuntime: true,
  fakeTickRates: [20, 10],
  exclusive: "a small fireball that missed the bot could set a fire in another lane's arena, which a shared server's lanes would all see",
  async run(subject) {
    const shooter = await mobAt(subject, "blaze", SHOOTER_X, 0.5);
    const notes: string[] = [];
    try {
      for (const { name, steps, expect } of CASES) {
        const soul = steps.some((step) => "contact" in step && step.contact === "soul_fire");
        await subject.setBlock(subject.world(FLOOR), soul ? "soul_soil" : "stone");
        await calm(subject);
        const watch = watchBurn(subject);
        try {
          for (const step of steps) await runStep(subject, step, watch, shooter.id);
          await settle(subject, watch);
          notes.push(await describeCase(subject, name, expect, watch));
        } catch (error) {
          throw new Error(`case ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        } finally {
          watch.stop();
        }
      }
    } finally {
      await subject.setBlock(subject.world(FLOOR), "stone");
      await subject.setBlock(subject.world(FEET), "air");
    }
    assert.ok(notes.length === CASES.length, "every case ran");
    return `MEASURED ${notes.join("; ")}`;
  },
};
