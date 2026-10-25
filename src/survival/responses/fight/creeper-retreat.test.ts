import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { retreatFromCreepers } from "./creeper-retreat.js";
import { CreeperClearance } from "../../perception/combat/creepers.js";

test("an escape with no physical progress expires without claiming clearance", async () => {
  const { bot, clock } = createFakeBot({ position: new Vec3(0, 64, 0), entities: { 7: { name: "creeper", position: new Vec3(3, 64, 0) } } });
  const controls = new Map<string, boolean>();
  const setControlState = bot.setControlState.bind(bot);
  bot.setControlState = (control, value) => { controls.set(control, value); setControlState(control, value); };
  let ticks = 0;
  bot.on("physicsTick", () => { ticks++; });
  const clearance = new CreeperClearance(bot);
  const outcome = retreatFromCreepers(bot, new AbortController().signal, () => false, { clearance, tick: () => ticks, dead: new Set() });
  // 90 ticks of no progress: 4.5 s of clock.
  await clock.advance(5_000);
  assert.equal(await outcome, "expired");
  assert.equal(clearance.pending, true);
  assert.equal(controls.get("forward"), false);
  assert.equal(controls.get("sprint"), false);
  const abort = new AbortController();
  const retreat = retreatFromCreepers(bot, abort.signal, () => false);
  await Promise.resolve();
  abort.abort(new Error("stop without another physics tick"));
  await assert.rejects(retreat, /stop without another physics tick/);
  assert.equal(controls.get("forward"), false);
});
