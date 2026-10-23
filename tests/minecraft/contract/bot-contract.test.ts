/**
 * Every contract check on the shared fake bot (the same checks run on a real server: `drivers/bot-contract.ts`).
 * A red check here is a fake that left the game: the fake changes, never the check (spec shared-fake-bot, design 4).
 * Each check runs at offset zero and in lane 3 (moved on x as well): its fixture is written in arena-local coordinates and the fake world is
 * built through the same frame as a lane's scenario, so a check that names a cell without `subject.world` finds no
 * block in the lane (plan 2026-10-23-shared-scenario-server T3).
 */
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeEntitySpec, createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { ZERO_ARENA, arenaFrame, type ArenaFrame } from "../arena/frame.ts";
import { CONTRACT_CHECKS, type ContractFixture } from "./checks.ts";
import { fakeContractSubject } from "./subject.ts";

/** Entity ids the fixture's entities get on the fake (the bot is 1). */
const FIRST_FIXTURE_ENTITY_ID = 100;
/** Lane 3 (`LANE_SPACING` 512 on z) with an x offset no lane has, so a check that forgets or doubles either axis is seen. */
const FRAMES: readonly { readonly label: string; readonly frame: ArenaFrame }[] = [
  { label: "offset zero", frame: arenaFrame(ZERO_ARENA) },
  { label: "lane 3, moved on x", frame: arenaFrame({ x: 1024, z: 1536 }) },
];

/** The fixture's world on the fake: the cells, stacks and feet as given, moved into the lane, the floor at the fake's default ground. */
function fakeHarnessFor(fixture: ContractFixture, frame: ArenaFrame) {
  const point = (local: readonly [number, number, number]) => new Vec3(...frame.world(local));
  const entities: Record<number, FakeEntitySpec> = {};
  (fixture.entities ?? []).forEach(({ name, position, passengers }, index) => {
    entities[FIRST_FIXTURE_ENTITY_ID + index] = { name, position: point(position), ...(passengers !== undefined && { passengers }) };
  });
  /** A fixture map keyed by `"x,y,z"` (cells, containers), keyed by the lane's cells. */
  const inLane = <T>(byCell: Readonly<Record<string, T>> | undefined) =>
    byCell && Object.fromEntries(Object.entries(byCell).map(([key, value]) => [frame.world(key.split(",").map(Number) as [number, number, number]).join(","), value]));
  return createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: point(fixture.position),
    cells: inLane(fixture.cells),
    carried: fixture.carried,
    containers: inLane(fixture.containers),
    entities,
    server: { timeOfDay: fixture.timeOfDay, weather: fixture.weather },
  });
}

for (const check of CONTRACT_CHECKS) {
  for (const { label, frame } of FRAMES) {
    test(`contract ${check.name} holds on the fake bot at ${label}`, async () => {
      const harness = fakeHarnessFor(check.fixture, frame);
      using _installed = harness.clock.install();
      await check.run(fakeContractSubject(harness, frame));
    });
  }
}
