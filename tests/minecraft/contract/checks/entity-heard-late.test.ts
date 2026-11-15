/**
 * Checks that read an entity the fixture summoned wait for the client to hear it: the server's `/summon` and the packet that makes the client see
 * the entity are two steps, and a check that reads at once is red when the packet is not in yet (plan 2026-11-15-p4-32-33-red-fixes T1).
 * The red run (`~/mcp/p4-32-evidence/p4-32-iso.log`, `boat-follows-vehicle-move`): the assert came 2.1 ms after `Summoned new Oak Boat`, the
 * spawn not yet heard, "no oak_boat entity in view" (1 run in 5). Here the fake's server tells the client of the entity 50 ms after a moment.
 */
import test from "node:test";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { boatFollowsVehicleMove } from "./boat-follows-vehicle-move.ts";
import { type FakeHarness, runOnFake } from "./run-on-fake.ts";
import { useEntitySneakInBoat } from "./use-entity-sneak-in-boat.ts";

/** The gap of the red run, rounded up: more than the 2.1 ms the assert came after the summon. */
const HEARD_AFTER_MS = 50;

/**
 * Run `check` on the fake with the fixture's entities named `late` left out, and told to the client `HEARD_AFTER_MS` after `startsAt` (`start`: the run's start;
 * `second mount`: the second time the bot sits in a vehicle, the moment a check reads what it reads right after mounting).
 */
function runWithEntitiesHeardLate(check: ContractCheck, late: readonly string[], startsAt: "start" | "second mount") {
  const arrivals = (check.fixture.entities ?? []).filter(({ name }) => late.includes(name));
  const fixture = { ...check.fixture, entities: (check.fixture.entities ?? []).filter(({ name }) => !late.includes(name)) };
  return runOnFake({ ...check, fixture }, {}, (subject, harness: FakeHarness) => {
    const tellClient = () =>
      harness.clock.after(HEARD_AFTER_MS, () => {
        for (const { name, position } of arrivals) harness.entities.spawn({ name, position: new Vec3(...subject.world(position).toArray()) });
      });
    if (startsAt === "start") tellClient();
    else {
      let mounts = 0;
      subject.bot.on("mount", () => void (++mounts === 2 && tellClient()));
    }
    return subject;
  });
}

test("boat-follows-vehicle-move waits for the boat when its spawn is heard 50 ms after the start", async () => {
  await runWithEntitiesHeardLate(boatFollowsVehicleMove, ["oak_boat"], "start");
});

test("use-entity-sneak-in-boat waits for the cow when its spawn is heard 50 ms after her second mount", async () => {
  await runWithEntitiesHeardLate(useEntitySneakInBoat, ["cow"], "second mount");
});
