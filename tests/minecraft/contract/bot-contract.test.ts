/**
 * Every contract check on the shared fake bot (the same checks run on a real server: `drivers/bot-contract.ts`).
 * A red check here is a fake that left the game: the fake changes, never the check (spec shared-fake-bot, design 4).
 */
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeEntitySpec, createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { CONTRACT_CHECKS, type ContractFixture } from "./checks.ts";
import { fakeContractSubject } from "./subject.ts";

/** Entity ids the fixture's entities get on the fake (the bot is 1). */
const FIRST_FIXTURE_ENTITY_ID = 100;

/** The fixture's world on the fake: the cells, stacks and feet as given, the floor at the fake's default ground. */
function fakeHarnessFor(fixture: ContractFixture) {
  const entities: Record<number, FakeEntitySpec> = {};
  (fixture.entities ?? []).forEach(({ name, position, passengers }, index) => {
    entities[FIRST_FIXTURE_ENTITY_ID + index] = { name, position: new Vec3(...position), ...(passengers !== undefined && { passengers }) };
  });
  return createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: new Vec3(...fixture.position),
    cells: fixture.cells,
    carried: fixture.carried,
    containers: fixture.containers,
    entities,
    server: { timeOfDay: fixture.timeOfDay, weather: fixture.weather },
  });
}

for (const check of CONTRACT_CHECKS) {
  test(`contract ${check.name} holds on the fake bot`, async () => {
    const harness = fakeHarnessFor(check.fixture);
    using _installed = harness.clock.install();
    await check.run(fakeContractSubject(harness));
  });
}
