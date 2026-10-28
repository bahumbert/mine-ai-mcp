/**
 * Who a `damage_event` names as the attacker (`/damage`, Mine Labs 1.21.4): `sourceCauseId` is the cause entity's id + 1, `sourceDirectId`
 * the direct entity's id + 1, and 0 for an absent one (Mineflayer's `entities.js:398-400` reads `sourceCauseId - 1`). A mob's attack
 * (`minecraft:mob_attack by <zombie>`) names the zombie as both; an arrow (`minecraft:arrow by <arrow> from <zombie>`) names the zombie as the
 * cause and the arrow as the direct entity; `minecraft:generic` names neither. The harness has one player, so a PLAYER as the cause is
 * unmeasured here: the live check of the relationships plan (Task 8) reads it. The runtime treats the encoding as measured and the cause
 * entity's type (a player) as Mineflayer's `entity.type`.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { afterServerTicks, answerArrives } from "../server-answer.ts";
import type { ContractSubject } from "../subject.ts";
import { type DamageEvent, NIGHT, STILL_MOB_NBT, damageTypeId, mobAt } from "./combat-scene.ts";

const DAMAGE = 2;
/** A second damage inside the first ten ticks is ignored (the hurt window): the next one waits for it to close. */
const HURT_WINDOW_TICKS = 10;
/** An arrow that hangs where it is summoned: no gravity, no hit on anything. */
const HANGING_ARROW_NBT = "{NoGravity:1b}";

type Listening = { on(event: string, listener: (packet: never) => void): void; off(event: string, listener: (packet: never) => void): void };

export const damageEventAttacker: ContractCheck = {
  name: "damage-event-attacker",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5], timeOfDay: NIGHT, entities: [{ name: "zombie", position: [2.5, -60, 0.5], nbt: STILL_MOB_NBT }] },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const zombie: Entity = await mobAt(subject, "zombie", 2.5, 0.5);
    const arrow = await subject.summonMob("arrow", subject.world([0.5, -59, 3.5]), HANGING_ARROW_NBT);
    const heard: DamageEvent[] = [];
    const onDamage = (event: DamageEvent) => void (event.entityId === bot.entity.id && heard.push(event));
    const client = bot._client as unknown as Listening;
    client.on("damage_event", onDamage);
    const hurt = async (hurtBy: () => Promise<void>, expected: { type: string; cause: number; direct: number }) => {
      heard.length = 0;
      await hurtBy();
      await answerArrives(subject, () => heard.length >= 1, `no damage_event for ${expected.type}`);
      const { sourceTypeId, sourceCauseId, sourceDirectId } = heard[0]!;
      assert.deepEqual({ sourceTypeId, sourceCauseId, sourceDirectId }, { sourceTypeId: damageTypeId(bot.registry, expected.type), sourceCauseId: expected.cause, sourceDirectId: expected.direct });
      await afterServerTicks(subject, HURT_WINDOW_TICKS, "the hurt window");
    };
    try {
      await hurt(() => subject.hurtBot(DAMAGE, zombie.id), { type: "mob_attack", cause: zombie.id + 1, direct: zombie.id + 1 });
      await hurt(() => subject.hurtBot(DAMAGE, zombie.id, arrow.id), { type: "arrow", cause: zombie.id + 1, direct: arrow.id + 1 });
      await hurt(() => subject.hurtBot(DAMAGE, null), { type: "generic", cause: 0, direct: 0 });
    } finally {
      client.off("damage_event", onDamage);
      await removeArrow(subject, arrow);
    }
  },
};

async function removeArrow(subject: ContractSubject, arrow: Entity): Promise<void> {
  if (subject.bot.entities[arrow.id] !== undefined) await subject.removeMob(arrow);
}
