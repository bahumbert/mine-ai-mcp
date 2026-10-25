/**
 * Every contract check on the shared fake bot (the same checks run on a real server: `drivers/bot-contract.ts`).
 * A red check here is a fake that left the game: the fake changes, never the check (spec shared-fake-bot, design 4).
 * Each check runs at offset zero and in lane 3 (moved on x as well): its fixture is written in arena-local coordinates and the fake world is
 * built through the same frame as a lane's scenario, so a check that names a cell without `subject.world` finds no
 * block in the lane (plan 2026-10-23-shared-scenario-server T3).
 */
import test from "node:test";
import { ZERO_ARENA, arenaFrame, type ArenaFrame } from "../arena/frame.ts";
import { CONTRACT_CHECKS } from "./checks.ts";
import { fakeHarnessFor } from "./fake-harness.ts";
import { fakeContractSubject } from "./subject.ts";

/** Lane 3 (`LANE_SPACING` 512 on z) with an x offset no lane has, so a check that forgets or doubles either axis is seen. */
const FRAMES: readonly { readonly label: string; readonly frame: ArenaFrame }[] = [
  { label: "offset zero", frame: arenaFrame(ZERO_ARENA) },
  { label: "lane 3, moved on x", frame: arenaFrame({ x: 1024, z: 1536 }) },
];

for (const check of CONTRACT_CHECKS) {
  for (const { label, frame } of FRAMES) {
    test(`contract ${check.name} holds on the fake bot at ${label}`, { skip: check.waitsForFake }, async () => {
      const harness = fakeHarnessFor(check.fixture, frame);
      using _installed = harness.clock.install();
      await check.run(fakeContractSubject(harness, frame));
    });
  }
}
