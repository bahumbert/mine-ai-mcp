/** A contract check's fixture built on the shared fake bot, in the lane a frame names: what `bot-contract.test.ts` and the tests of one check's edge cases run on. */
import { Vec3 } from "vec3";
import { type FakeEntitySpec, type FakeServerOptions, createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import type { ArenaFrame } from "../arena/frame.ts";
import type { ContractFixture } from "./checks.ts";

/** Entity ids the fixture's entities get on the fake (the bot is 1). */
const FIRST_FIXTURE_ENTITY_ID = 100;

/** The fixture's world on the fake: the cells, stacks and feet as given, moved into the lane, the floor at the fake's default ground; `server` sets how the fake server behaves (it starts with the fixture's day time and weather); every server answer takes `lagMs` of clock. */
export function fakeHarnessFor(fixture: ContractFixture, frame: ArenaFrame, server: Omit<FakeServerOptions, "lagMs"> = {}, lagMs = 0) {
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
    lagMs,
    server: { timeOfDay: fixture.timeOfDay, weather: fixture.weather, ...server },
  });
}
