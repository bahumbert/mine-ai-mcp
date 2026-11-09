// Compare natural zombie damage with the runtime formula, without a reflex moving or fighting the subject.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientCompletion } from "mine-labs/client";
import type { Entity } from "prismarine-entity";
import { botDefence } from "../../../src/world/combat-stats.ts";
import { damageAfterArmor, MOB_MELEE_INTERVAL_TICKS, scaleForDifficulty } from "../../../src/survival/perception/combat/threat-assessment.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { serverContractSubject, type ContractSubject } from "../contract/subject.ts";
import { answerArrives } from "../contract/server-answer.ts";
import type { ScenarioContext } from "../scenario.ts";

interface Hit { readonly damage: number; readonly physicsTick: number; readonly serverTick: Promise<number> }
interface Reading {
  readonly chest: string;
  readonly armor: number;
  readonly expected: number;
  readonly damage: number[];
  readonly intervalPhysicsTicks: number;
  readonly intervalServerTicks: number;
  readonly referenceIntervalTicks: number;
}
const EMPTY_MOB = "{PersistenceRequired:1b,IsBaby:0b,HandItems:[{},{}],ArmorItems:[{},{},{},{}]}";

/** Two natural hits per equipment state: the game supplies the health drop independently of the tested formula. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const subject = serverContractSubject(context.bot, context.arena);
  assert.equal(context.bot.game.difficulty, "normal");
  const readings: Reading[] = [];
  for (const chest of ["air", "iron_chestplate"]) {
    context.bot.chat(`/item replace entity @s armor.chest with minecraft:${chest}`);
    const armor = chest === "air" ? 0 : 6;
    await answerArrives(subject, () => botDefence(context.bot).armor === armor, `${chest} armour attributes`);
    const hits = await naturalHits(context, subject);
    const expected = damageAfterArmor(scaleForDifficulty(3, "normal", "when_caused_by_living_non_player"), armor, 0);
    const serverTicks = await Promise.all(hits.map(hit => hit.serverTick));
    const reading = { chest, armor, expected, damage: hits.map(hit => hit.damage),
      intervalPhysicsTicks: hits[1]!.physicsTick - hits[0]!.physicsTick,
      intervalServerTicks: serverTicks[1]! - serverTicks[0]!, referenceIntervalTicks: MOB_MELEE_INTERVAL_TICKS };
    console.log(`zombie-hit-formula ${JSON.stringify(reading)}`);
    readings.push(reading);
    for (const hit of hits) assert.ok(Math.abs(hit.damage - expected) <= 0.5, JSON.stringify(reading));
  }
  return { status: "succeeded", detail: JSON.stringify(readings) };
}

/** Keep knockback inside the YAML's glass pen; read only health updates attributed to this zombie's hurt event. */
async function naturalHits(context: ScenarioContext, subject: ContractSubject): Promise<Hit[]> {
  const { bot } = context;
  const hits: Hit[] = [];
  let physicsTick = 0;
  let previousHealth = bot.health;
  let sourceId: number | null = null;
  let zombieId: number | null = null;
  const onTick = () => { physicsTick++; };
  const onHurt = (entity: Entity, source?: Entity) => {
    if (entity.id === bot.entity.id) sourceId = source?.id ?? null;
  };
  const onHealth = () => {
    const damage = previousHealth - bot.health;
    previousHealth = bot.health;
    if (sourceId === zombieId && zombieId !== null && damage > 0 && hits.length < 2)
      hits.push({ damage, physicsTick, serverTick: subject.serverGameTime() });
    sourceId = null;
  };
  bot.on("physicsTick", onTick);
  bot.on("entityHurt", onHurt);
  bot.on("health", onHealth);
  try {
    const zombie = await subject.summonMob("zombie", subject.world([1.5, -60, 0.5]), EMPTY_MOB);
    zombieId = zombie.id;
    const deadline = monotonicNow() + 10_000;
    while (hits.length < 2 && bot.health > 0 && monotonicNow() < deadline) await delay(20);
    assert.equal(hits.length, 2, `wanted two natural hits, saw ${hits.length}, health ${bot.health}`);
    await Promise.all(hits.map(hit => hit.serverTick));
    return hits;
  } finally {
    bot.off("physicsTick", onTick);
    bot.off("entityHurt", onHurt);
    bot.off("health", onHealth);
    if (zombieId !== null && bot.entities[zombieId]) await subject.kill(zombieId);
  }
}
