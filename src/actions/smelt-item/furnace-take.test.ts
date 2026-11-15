// Furnace takes counted from predictions only after the server has had time to correct them.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/fake-bot.js";
import { createFakeClock } from "../../test-support/fake-bot/fake-clock.js";
import { itemOf } from "../../test-support/fake-bot/fake-inventory.js";
import { itemWithCount } from "../../test-support/fake-bot/item-variants.js";
import { listenersAddedSince } from "../../test-support/fake-bot/listener-counts.js";
import { answerTakes, playerPartCount, sendTake, watchWindowAnswers } from "./furnace-take.js";

/** B2's measured furnace, with an installed clock so the production wait sees simulated time. */
async function furnace(ticksPerSecond = 20, options: Parameters<typeof createFakeBot>[0] = {}) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    cells: { "2,64,0": "furnace" },
    containers: { "2,64,0": { raw_iron: 64, coal: 64, iron_ingot: 2 } },
    server: { ticksPerSecond },
    ...options,
  });
  const window = await harness.clock.settle(harness.bot.openFurnace(harness.bot.blockAt(new Vec3(2, 64, 0))!), 5_000);
  return { ...harness, window };
}

for (const rate of [20, 5]) {
  test(`accepted takes at ${rate} tps wait for 40 world ticks each, then release every witness listener`, async () => {
    const { bot, clock, window, server } = await furnace(rate, { carried: { iron_ingot: 3 } });
    using _installed = clock.install();
    const added = listenersAddedSince(bot._client);
    const windowAdded = listenersAddedSince(window);
    const answers = watchWindowAnswers(bot, window);
    const counts: number[] = [];
    const ages: number[] = [];
    try {
      for (const source of ["output", "input", "fuel"] as const) {
        const original = window[`${source}Item`]()!;
        const take = (await sendTake(bot, window, source))!;
        if (source === "output") {
          assert.deepEqual([take.sourceBefore, take.playerBefore, take.inventoryBefore, take.predicted], [2, 3, 3, 2]);
          original.count = 99;
          assert.equal(take.like.count, 2);
        }
        ages.push(take.sentAtAge!);
        let settled = false;
        const pending = answerTakes(bot, window, [take], answers).then((value) => { settled = true; return value; });
        const minimum = rate === 5 ? 3_950 : 950;
        await clock.advance(minimum);
        assert.equal(settled, false, `${source} is still predicted at the low end minus 50 ms`);
        const result = await clock.settle(pending, (rate === 5 ? 8_050 : 2_050) - minimum, 25);
        assert.ok(bot.time.age - take.sentAtAge! >= 40);
        assert.deepEqual([result.answer, result.errors, answers.corrected()], ["answered", [], false]);
        counts.push(result.counts[0]!);
      }
      assert.deepEqual(counts, [2, 64, 64]);
      assert.ok(ages[1]! - ages[0]! >= 40 && ages[2]! - ages[1]! >= 40);
      assert.equal(server.packets.filter(({ name }) => name === "window_click").length, 3);
    } finally {
      answers.dispose();
      answers.dispose();
    }
    for (const name of ["set_slot", "window_items", "set_cursor_item"]) assert.equal(added(name), 0);
    assert.equal(windowAdded("close"), 0);
  });
}

for (const duringClick of [false, true]) {
  test(`a stale output is corrected from x1 to x2${duringClick ? " before the click promise returns" : " while waiting"}`, async () => {
    const { bot, clock, window } = await furnace();
    using _installed = clock.install();
    const output = window.outputItem()!;
    // B1: reports/2026-11-15-tests-followups/furnace-take-corrected.md, Branch R (set_slot x2, then resyncs).
    window.updateSlot(output.slot, itemWithCount(bot.registry, output, 1));
    const answers = watchWindowAnswers(bot, window);
    const click = bot.clickWindow.bind(bot);
    if (duringClick) bot.clickWindow = async (...args) => { await click(...args); await clock.advance(50); };
    try {
      const take = (await sendTake(bot, window, "output"))!;
      assert.equal(take.predicted, 1);
      if (duringClick) assert.equal(answers.corrected(), true);
      const result = await clock.settle(answerTakes(bot, window, [take], answers), 2_050, 25);
      assert.deepEqual(result, { counts: [2], errors: [], answer: "answered" });
    } finally { answers.dispose(); }
  });
}

test("a corrected take sharing a variant with an earlier answered take keeps its prediction", async () => {
  const { bot, clock, window, windows } = await furnace();
  using _installed = clock.install();
  windows.setContainerStacks("2,64,0", [{ slot: 0, name: "coal", count: 2 }, { slot: 1, name: "coal", count: 2 }]);
  const answers = watchWindowAnswers(bot, window);
  try {
    const input = (await sendTake(bot, window, "input"))!;
    assert.deepEqual((await clock.settle(answerTakes(bot, window, [input], answers), 2_050)).counts, [2]);
    const fuel = window.fuelItem()!;
    window.updateSlot(fuel.slot, itemWithCount(bot.registry, fuel, 1));
    const take = (await sendTake(bot, window, "fuel"))!;
    const result = await clock.settle(answerTakes(bot, window, [take], answers), 2_050);
    assert.deepEqual(result.counts, [1]);
    assert.deepEqual(result.errors, ["The server corrected a furnace take of coal that another take shares; its count is read after close."]);
  } finally { answers.dispose(); }
});

test("a stopped server clock is unconfirmed after 20 seconds of still age", async () => {
  const { bot, clock, window, server } = await furnace();
  using _installed = clock.install();
  const answers = watchWindowAnswers(bot, window);
  server.stop();
  try {
    const take = (await sendTake(bot, window, "output"))!;
    let settled = false;
    const pending = answerTakes(bot, window, [take], answers).then((value) => { settled = true; return value; });
    await clock.advance(19_950);
    assert.equal(settled, false);
    const result = await clock.settle(pending, 100, 25);
    assert.equal(result.answer, "stalled");
    assert.deepEqual(result.errors, ["The server's clock stood still for 20 s after a furnace take: the take is not confirmed."]);
  } finally { answers.dispose(); }
});

for (const end of ["close", "abort"] as const) {
  test(`${end} during an answer wait settles within one poll and disposes its listeners`, async () => {
    const { bot, clock, window, windows } = await furnace();
    using _installed = clock.install();
    const added = listenersAddedSince(bot._client);
    const windowAdded = listenersAddedSince(window);
    const answers = watchWindowAnswers(bot, window);
    const controller = new AbortController();
    try {
      const take = (await sendTake(bot, window, "output"))!;
      const pending = answerTakes(bot, window, [take], answers, controller.signal);
      if (end === "close") windows.closeOpenWindow();
      else controller.abort();
      const result = await clock.settle(pending, 25, 25);
      assert.equal(result.answer, end === "close" ? "closed" : "aborted");
      assert.deepEqual(result.counts, [2]);
      assert.deepEqual(result.errors, end === "close" ? ["The furnace window closed before the take was answered."] : []);
    } finally { answers.dispose(); }
    for (const name of ["set_slot", "window_items", "set_cursor_item"]) assert.equal(added(name), 0);
    assert.equal(windowAdded("close"), 0);
  });
}

test("a no-longer-current or closed window refuses a take before any click", async () => {
  for (const close of [false, true]) {
    const { bot, window, server } = await furnace();
    const answers = watchWindowAnswers(bot, window);
    try {
      if (close) window.emit("close");
      else bot.currentWindow = null;
      assert.equal(answers.closed(), true);
      await assert.rejects(sendTake(bot, window, "output"), /The furnace window closed before the take/);
      assert.equal(server.packets.filter(({ name }) => name === "window_click").length, 0);
    } finally { answers.dispose(); }
  }
});

test("a full inventory refuses a take without writing; an empty source writes nothing", async () => {
  const slots = Object.fromEntries(Array.from({ length: 36 }, (_, i) => [i + 9, { name: "cobblestone", count: 64 }]));
  const { bot, window, server } = await furnace(20, { slots });
  await assert.rejects(sendTake(bot, window, "output"), /No inventory room for furnace output iron_ingot x2/);
  window.slots[window.outputItem()!.slot] = null;
  assert.equal(await sendTake(bot, window, "output"), null);
  assert.equal(server.packets.filter(({ name }) => name === "window_click").length, 0);
});

test("the player part excludes source slots and distinguishes item variants", async () => {
  const { bot, window } = await furnace();
  const plain = itemOf(bot.registry, "coal", 3);
  window.updateSlot(window.inventoryStart, plain);
  assert.equal(playerPartCount(window, plain), 3);
  const renamed = itemOf(bot.registry, "renamed_first_cobblestone", 4);
  window.updateSlot(window.inventoryStart + 1, renamed);
  window.updateSlot(window.inventoryStart + 2, itemOf(bot.registry, "renamed_second_cobblestone", 5));
  assert.equal(playerPartCount(window, renamed), 4);
});

test("a full resync alone corrects the take, without a player-slot correction", async () => {
  const { bot, clock, window } = await furnace();
  using _installed = clock.install();
  const output = window.outputItem()!;
  window.updateSlot(output.slot, itemWithCount(bot.registry, output, 1));
  const write = bot._client.write.bind(bot._client);
  // A stale state id asks the existing fake server for a full resync (contract click-window-hotbar-swap).
  bot._client.write = (name, packet) => write(name, name === "window_click" ? { ...packet, stateId: -1 } : packet);
  const answers = watchWindowAnswers(bot, window);
  try {
    const take = (await sendTake(bot, window, "output"))!;
    await clock.advance(50);
    assert.deepEqual([answers.corrected(), answers.resynced()], [false, true]);
    const result = await clock.settle(answerTakes(bot, window, [take], answers), 2_050);
    assert.deepEqual(result, { counts: [2], errors: [], answer: "answered" });
  } finally { answers.dispose(); }
});

test("a server correction removing the whole predicted gain reports no confirmed output", async () => {
  const { bot, clock, window, windows } = await furnace();
  using _installed = clock.install();
  const answers = watchWindowAnswers(bot, window);
  try {
    const take = (await sendTake(bot, window, "output"))!;
    windows.setContainerStacks("2,64,0", []);
    const result = await clock.settle(answerTakes(bot, window, [take], answers), 2_050);
    assert.deepEqual(result, { counts: [0], errors: ["Inventory did not confirm furnace output iron_ingot."], answer: "answered" });
  } finally { answers.dispose(); }
});
