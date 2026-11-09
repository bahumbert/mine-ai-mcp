import assert from "node:assert/strict";
import test from "node:test";
import { FakeRuntime } from "./testing.ts";
import type { Position } from "./runtime-client.ts";

/** The cover report a foreground route leaves cover at, as the runtime sends it while `report_open_sky` is on (the shape the scenario `navigation/report-open-sky` reported: `.agent/knowledge/facts/navigation-and-boats.md`). */
function planCoverExit(fake: FakeRuntime, at: Position): void {
  if (fake.snapshot.policy?.reportOpenSky !== true) return;
  fake.snapshot = { ...fake.snapshot, coverExit: { at, plannedAt: "2026-11-09T00:00:00.000Z", reached: true } };
}

test("a policy setter keeps the other policy fields (cross-plan level-2 gap 10)", async () => {
  const fake = new FakeRuntime();
  fake.snapshot = { ...fake.snapshot, policy: { revision: "r1", digStraightDown: false, scaffoldBlocks: ["cobblestone"] } };
  assert.equal(await fake.setReportOpenSky(true, "r1"), true);
  assert.deepEqual((await fake.status()).policy, { revision: "r1+", digStraightDown: false, scaffoldBlocks: ["cobblestone"], reportOpenSky: true });
  assert.equal(await fake.setDigStraightDown(true, "r1+"), true);
  assert.deepEqual((await fake.status()).policy, { revision: "r1++", digStraightDown: true, scaffoldBlocks: ["cobblestone"], reportOpenSky: true });
});

test("setReportOpenSky refuses a stale revision and changes nothing", async () => {
  const fake = new FakeRuntime();
  fake.snapshot = { ...fake.snapshot, policy: { revision: "r1", digStraightDown: true } };
  assert.equal(await fake.setReportOpenSky(true, "r0"), false);
  assert.equal((await fake.status()).policy?.reportOpenSky, undefined);
});

test("planCoverExit reports the exit only while report_open_sky is on, as the runtime does", async () => {
  const fake = new FakeRuntime();
  const at = { x: 6, y: -60, z: 512 };
  fake.snapshot = { ...fake.snapshot, policy: { revision: "r1", digStraightDown: true } };
  planCoverExit(fake, at);
  assert.equal((await fake.status()).coverExit ?? null, null);
  assert.equal(await fake.setReportOpenSky(true, "r1"), true);
  planCoverExit(fake, at);
  assert.deepEqual((await fake.status()).coverExit, { at, plannedAt: "2026-11-09T00:00:00.000Z", reached: true });
});
