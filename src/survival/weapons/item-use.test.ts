import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { CombatItemUse } from "./item-use.js";

test("drawing a bow releases server shield use even after local posture was invalidated", async () => {
  let serverHand: "shield" | "bow" | null = null;
  let arrows = 0;
  const { bot, server } = createFakeBot({
    // Not on the shared fake: the use requests, answered here as vanilla does.
    overrides: {
      activateItem: (offHand = false) => {
        // Native use requests cannot switch hands while another hand is active.
        serverHand ??= offHand ? "shield" : "bow";
      },
      deactivateItem: () => {
        if (serverHand === "bow") arrows++;
        serverHand = null;
      },
    },
  });
  // A held slot change ends the item use on the server.
  server.onPacket("held_item_slot", () => {
    serverHand = null;
  });
  const use = new CombatItemUse(bot, async () => {});
  await use.raiseShield();
  use.invalidateShield(); // Refused construction did not release the native use.
  using draw = use.drawBow();
  draw.release();
  assert.equal(arrows, 1, "release must fire a bow, not merely lower the still-active shield");
  assert.equal(serverHand, null);
});

/** The shared fake bot with its item release and control clearing written to `order`. */
function recordedBot(order: string[]) {
  const harness = createFakeBot({ overrides: { deactivateItem: () => void order.push("release use") } });
  const clear = harness.bot.clearControlStates.bind(harness.bot);
  harness.bot.clearControlStates = () => {
    order.push("clear movement");
    clear();
  };
  return harness;
}

test("cleanup settles the body after the final item-release tick can deliver knockback", async () => {
  let grounded = true;
  let settledAirborne = false;
  const order: string[] = [];
  const { bot, clock } = recordedBot(order);
  const cleanup = new CombatItemUse(bot, async () => {}).neutralise(async () => {
    settledAirborne = !grounded;
    grounded = true;
    order.push("land");
  }, new AbortController().signal);
  grounded = false;
  order.push("knockback arrives");
  await clock.advance(50);
  await cleanup;
  assert.equal(settledAirborne, true, "the health cancellation precedes the velocity packet");
  assert.equal(grounded, true, "no awaited cleanup remains after the physical handoff");
  assert.ok(order.indexOf("land") > order.indexOf("knockback arrives"));
  assert.ok(order.lastIndexOf("clear movement") > order.indexOf("land"));
});

test("body cancellation settles item release even when physics has stopped", async () => {
  // Not on the shared fake until M1 merges: the release of item use (a packet, no answer).
  const { bot } = createFakeBot({ overrides: { deactivateItem: () => undefined } });
  const owner = new AbortController();
  let settled = false;
  const cleanup = new CombatItemUse(bot, async () => {}).neutralise(async () => {
    settled = true;
  }, owner.signal);
  owner.abort(new Error("body released"));
  await cleanup;
  assert.equal(settled, true);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});
