import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, itemOf } from "../../../test-support/fake-bot/index.js";
import { regionRefusalText, setProtectedRegionsProvider, type ProtectedRegion } from "../../../world/protected-regions.js";
import { buildProtection, fullProtectionBlock } from "./build-protection.js";

/** Protection walls and regions (plan 2026-11-07-p4-06a-threat T5a, ADR-012). */
const column = (x: number, owner: string, regionId: number): ProtectedRegion => ({
  regionId, dimension: "overworld", min: { x, y: 60, z: -5 }, max: { x, y: 70, z: 5 }, owner, label: "a build",
});

/** A fresh transaction closes observed air without carrying stale excavation state. */
async function assertOpenCellIsRepaired(
  bot: ReturnType<typeof createFakeBot>["bot"], clock: ReturnType<typeof createFakeClock>, cell: Vec3,
): Promise<void> {
  const next = await clock.settle(buildProtection(bot, [cell], {
    signal: new AbortController().signal, mayContinue: () => null, terrain: { dig: true, place: true },
    clearCell: async () => { throw new Error("the next pass must read the open cell"); },
  }), 1_000);
  assert.equal(next.kind, "built");
  assert.equal(bot.blockAt(cell)?.name, "cobblestone");
}

test("an obstructed protection cell is cleared only when it can be closed, and its supplies are read again", async () => {
  for (const variant of ["clear", "no port", "refused", "no block", "no support", "block lost", "support lost", "abort", "abort during", "block lost before clear", "support lost before clear"] as const) {
    const cell = new Vec3(1, 64, 0);
    const clock = createFakeClock({ mode: "mocked" });
    const { bot, world, inventory } = createFakeBot({
      clock, gameMode: "creative", carried: variant === "no block" ? {} : { cobblestone: 8 },
      cells: { "1,64,0": "nether_brick_fence" },
      groundY: variant === "no support" ? 40 : 63,
    });
    using _timers = clock.install();
    assert.equal(fullProtectionBlock(bot.blockAt(cell)), false);
    const abort = new AbortController();
    let clears = 0;
    const clearCell = async () => {
      clears++;
      if (variant === "abort during") {
        abort.abort(new Error("cancel during clearing"));
        abort.signal.throwIfAborted();
      }
      if (variant === "refused") return "server refused the break";
      world.setCell(cell, "air");
      if (variant === "block lost") inventory.slots.fill(null);
      if (variant === "support lost") world.setCell(cell.offset(0, -1, 0), "air");
      if (variant === "abort") abort.abort(new Error("cancel after clearing"));
      return "cleared";
    };
    let checks = 0;
    const work = buildProtection(bot, [cell], {
      signal: abort.signal, mayContinue: () => {
        if (++checks === 2 && variant === "block lost before clear") inventory.slots.fill(null);
        if (checks === 2 && variant === "support lost before clear") world.setCell(cell.offset(0, -1, 0), "air");
        return null;
      }, terrain: { dig: true, place: true },
      ...(variant === "no port" ? {} : { clearCell }),
    });
    if (variant === "abort" || variant === "abort during") {
      await assert.rejects(clock.settle(work, 1_000), /cancel .* clearing/);
      if (variant === "abort") await assertOpenCellIsRepaired(bot, clock, cell);
      continue;
    }
    const result = await clock.settle(work, 1_000);
    assert.equal(result.kind, variant === "clear" ? "built" : "blocked", variant);
    assert.equal(clears, ["no port", "no block", "no support", "block lost before clear", "support lost before clear"].includes(variant) ? 0 : 1, variant);
    if (result.kind === "built") assert.equal(bot.blockAt(cell)?.name, "cobblestone");
    else if (variant === "block lost" || variant === "support lost") assert.match(result.reason, /cell .* dug and left open:/);
    else if (variant === "no port" || variant === "refused") {
      assert.match(result.reason, /cannot be replaced by placement/);
      if (variant === "refused") assert.match(result.reason, /server refused the break/);
    }
    if (variant === "block lost" || variant === "support lost") {
      inventory.updateSlot(36, itemOf(world.registry, "cobblestone", 8));
      world.setCell(cell.offset(0, -1, 0), "stone");
      await assertOpenCellIsRepaired(bot, clock, cell);
    }
  }
});

test("a protection wall fills the cells outside every region first, the bot's own region's next, and stops at another owner's", async () => {
  const foreign = column(1, "Tom", 8);
  const { bot, clock, server } = createFakeBot({
    username: "Ayla", gameMode: "creative", position: new Vec3(3.5, 64, 3.5), carried: { cobblestone: 8 },
    clock: createFakeClock({ mode: "mocked" }),
  });
  setProtectedRegionsProvider(bot, () => [foreign, column(0, "Ayla", 9)]);
  using _timers = clock.install();
  const cells = [new Vec3(1, 64, 0), new Vec3(0, 64, 0), new Vec3(2, 64, 0)];
  const built = await clock.settle(
    buildProtection(bot, cells, {
      signal: new AbortController().signal,
      mayContinue: () => null,
      terrain: { dig: false, place: true },
    }),
    200,
  );
  assert.equal(built.kind, "blocked");
  if (built.kind === "blocked") {
    assert.deepEqual(built.placed.map((cell) => cell.toString()), [new Vec3(2, 64, 0), new Vec3(0, 64, 0)].map((cell) => cell.toString()));
    assert.ok(built.reason.includes(regionRefusalText(foreign)), built.reason);
  }
  assert.equal(server.packets.filter((packet) => packet.name === "block_place").length, 2, "the foreign cell got no packet");
});
