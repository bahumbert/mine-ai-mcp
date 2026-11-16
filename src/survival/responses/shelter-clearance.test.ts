// Clearance budgets use the selected carried stack, including its enchantments.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createNavigationRuntime, installNativeDigClock } from "../../navigation/index.js";
import { combatTestContext } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, itemOf } from "../../test-support/fake-bot/index.js";
import { CombatItemUse } from "../weapons/item-use.js";
import type { ShelterBuild } from "./shelter-build.js";
import { clearShelterCell } from "./shelter-clearance.js";

test("wall clearance reserves the native dig answer, including the exact budget boundary", async () => {
  for (const leftMs of [1_750, 1_700]) {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot } = createFakeBot({ clock, cells: { "1,64,0": "dirt" } });
    using _installed = clock.install();
    installNativeDigClock(bot);
    await using navigation = createNavigationRuntime(bot);
    const build: ShelterBuild = {
      bot, options: { navigation, signal: new AbortController().signal, threatContext: combatTestContext(bot),
        maximumMs: leftMs, recoverTo: 7 },
      itemUse: new CombatItemUse(bot, (ticks) => clock.sleep(ticks * 50)),
      constructionDeadline: clock.now() + leftMs, enclosed: false,
      dug: 0, walled: 0, capped: false, ate: null, swings: 0, recovery: null, refusal: null,
      pass: 0, blockedCells: new Map(),
    };
    const cell = new Vec3(1, 64, 0);
    const result = await clock.settle(clearShelterCell(build, cell, build.options.signal), 5_000);
    if (leftMs === 1_750) assert.equal(result, "cleared");
    else {
      assert.match(result, /0\.8 s.*1\.8 s including the server answer/);
      assert.match(result, /Use a faster tool or another shelter cell/);
    }
    assert.equal(bot.blockAt(cell)?.name, leftMs === 1_750 ? "air" : "dirt");
  }
});

test("a faster enchanted stack is priced even when a plain tool of the same type is held", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, world, inventory, server } = createFakeBot({
    clock, carried: { iron_pickaxe: 1 }, cells: { "1,65,0": "nether_brick_fence" },
  });
  using _installed = clock.install();
  await using navigation = createNavigationRuntime(bot);
  inventory.slots[36]!.enchants = [{ name: "efficiency", lvl: 3 }];
  const plain = itemOf(world.registry, "iron_pickaxe");
  inventory.updateSlot(38, plain);
  await bot.equip(plain, "hand");
  const build: ShelterBuild = {
    bot, options: { navigation, signal: new AbortController().signal, threatContext: combatTestContext(bot),
      maximumMs: 1_400, recoverTo: 7 },
    itemUse: new CombatItemUse(bot, (ticks) => clock.sleep(ticks * 50)),
    constructionDeadline: clock.now() + 1_400, enclosed: false,
    dug: 0, walled: 0, capped: false, ate: null, swings: 0, recovery: null, refusal: null,
    pass: 0, blockedCells: new Map(),
  };
  const stop = server.onPacket("block_dig", (data) => {
    const packet = data as { status: number; location: Vec3 };
    if (packet.status === 2) clock.after(50, () => {
      world.setCell(packet.location, "air");
      bot._client.emit("block_change", { location: packet.location, type: 0 });
    });
  });
  try {
    const result = await clock.settle(clearShelterCell(build, new Vec3(1, 65, 0), build.options.signal), 1_000);
    assert.equal(result, "cleared");
    assert.equal(bot.blockAt(new Vec3(1, 65, 0))?.name, "air");
    assert.ok(clock.now() <= build.constructionDeadline, "the selected tool closes the dig within its priced budget");
  } finally { stop(); }
});
