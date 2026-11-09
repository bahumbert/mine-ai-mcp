// The attack packet's sneak field changes the server's shift state even while riding.
import assert from "node:assert/strict";
import { getOff } from "../../../../src/actions/navigate/boat-get-off.ts";
import type { ContractCheck } from "../checks.ts";
import { answerArrives, serverQuiet } from "../server-answer.ts";
import { BOAT_FIXTURE, getOffAndStand, mountBoat } from "./boat-seat.ts";
import { settleWithin } from "../subject.ts";

export const useEntitySneakInBoat: ContractCheck = {
  name: "use-entity-sneak-in-boat",
  fixture: { ...BOAT_FIXTURE, entities: [...BOAT_FIXTURE.entities!, { name: "cow", position: [3.5, -60, 2.5], nbt: "{NoAI:1b,Silent:1b,PersistenceRequired:1b}" }] },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const { boat } = await mountBoat(subject);
    const abort = new AbortController();
    const cancelled = getOff(bot, abort.signal);
    const reason = new Error("cancel during get-off");
    abort.abort(reason);
    const ended = await settleWithin(subject, cancelled, 100);
    assert.equal(ended?.error, reason, "cancelled get-off did not reject promptly");
    await getOffAndStand(subject, boat);
    await mountBoat(subject);
    const target = Object.values(bot.entities).find((entity) => entity.name === "cow" && entity.position.distanceTo(boat.position) < 4);
    assert.ok(target, "no nearby cow to attack");
    let hurts = 0;
    const onHurt = (entity: typeof bot.entity) => { if (entity.id === target.id) hurts++; };
    bot.on("entityHurt", onHurt);
    try {
      for (const sneaking of [false, true]) {
        const before = hurts;
        bot._client.write("use_entity", { target: target.id, mouse: 1, sneaking });
        await answerArrives(subject, () => hurts > before, `attack with sneaking=${sneaking} did not hurt the cow`);
        await serverQuiet(subject, `attack with sneaking=${sneaking} while seated`);
        assert.equal(await subject.seatedOnServer(boat), !sneaking, `wrong seat state after sneaking=${sneaking}`);
      }
    } finally {
      bot.off("entityHurt", onHurt);
    }
    await getOffAndStand(subject, boat);
  },
};
