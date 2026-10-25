import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../../../src/test-support/fake-bot/index.ts";
import { arenaFrame } from "../../arena/frame.ts";
import { fakeContractSubject } from "../subject.ts";
import { BOAT_FIXTURE, mountBoat } from "./boat-seat.ts";

test("mountBoat seats her in the boat the fixture summoned, not in another oak boat in view", async () => {
  const frame = arenaFrame({ x: 0, z: 1536 });
  const [summoned] = BOAT_FIXTURE.entities!;
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: new Vec3(...frame.world(BOAT_FIXTURE.position)),
    // The decoy has the lower id, so a pick of the first oak boat in the list takes it.
    entities: {
      50: { name: "oak_boat", position: new Vec3(...frame.world([30.5, -60, 0.5])) },
      100: { name: "oak_boat", position: new Vec3(...frame.world(summoned!.position)) },
    },
  });
  using _installed = harness.clock.install();
  const boat = await mountBoat(fakeContractSubject(harness, frame));
  assert.equal(boat.id, 100);
  assert.equal(harness.bot.vehicle?.id, 100);
});
