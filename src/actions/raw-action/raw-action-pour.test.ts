// Raw bucket use shares the ordinary pour's body and protected-region guards.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { protectedRegion } from "../../test-support/protected-region.js";
import { executeRawAction } from "./raw-action.js";

test("raw off-hand lava beside a player's head over a hole is refused", async () => {
  const { bot, clock, server } = createFakeBot({
    position: new Vec3(0.5, 64, 0.5), groundY: 61,
    cells: { "3,65,0": "stone" },
    slots: { 45: { name: "lava_bucket" } },
    players: { Alex: { sleeping: false } },
  });
  bot.players.Alex!.entity!.position.set(2.5, 64, 1.5);
  await bot.lookAt(new Vec3(3, 65.5, 0.5), true);
  const running = executeRawAction(bot, { operation: "use_item", hand: "off-hand" }, {});
  await clock.advance(100);
  const result = await running;
  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /BUCKET_POUR_REACHES_BODY.*Alex/);
  assert.equal(result.attempted, false);
  assert.equal(server.packets.filter(packet => packet.name === "use_item").length, 0);
});

for (const hand of ["hand", "off-hand"] as const) {
  for (const liquid of ["water", "lava"] as const) {
    test(`raw ${liquid} in ${hand} refuses a foreign region and allows its owner`, async () => {
      const { bot, clock, server } = createFakeBot({
        position: new Vec3(0.5, 64, 0.5), groundY: 63,
        slots: { [hand === "hand" ? 36 : 45]: { name: `${liquid}_bucket` } },
      });
      let owner = "Alex";
      setProtectedRegionsProvider(bot, () => [protectedRegion({
        regionId: 7, owner, label: "garden", dimension: bot.game.dimension,
        min: { x: 0, y: 64, z: 2 }, max: { x: 0, y: 64, z: 2 },
      })]);
      await bot.lookAt(new Vec3(0.5, 64, 2.5), true);
      const running = executeRawAction(bot, { operation: "use_item", hand }, {});
      await clock.advance(100);
      const result = await running;
      assert.equal(result.status, "failed");
      assert.match("error" in result ? result.error : "", /BUCKET_POUR_PROTECTED_REGION.*garden.*Alex/);
      assert.equal(result.attempted, false);
      assert.equal(server.packets.filter(packet => packet.name === "use_item").length, 0);
      owner = bot.username;
      const allowed = executeRawAction(bot, { operation: "use_item", hand }, {});
      await clock.advance(100);
      assert.equal((await allowed).status, "succeeded");
    });
  }
}
