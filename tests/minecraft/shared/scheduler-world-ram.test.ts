// A lane server whose world goes to RAM: the scheduler asks the daemon for the template's size, the admission reserves it for a new server, and the pool holds it until the copy ends (spec 2026-11-15-scenario-disk-stalls 3.1).
import test from "node:test";
import assert from "node:assert/strict";
import { fixtureScenario } from "./scenario-fixture.ts";
import { lanePlacement, ownPlacement, SchedulerRig } from "./scheduler-rig.ts";
import { lanes } from "./scheduler-queue-fixtures.ts";

const WORLD_MB = 440;
const VERSION = fixtureScenario(60).minecraft.version;
/** The daemon's answer: the template of the scenarios' version is 440 MB, any other version has none. */
const worldMbFor = (version: string) => (version === VERSION ? WORLD_MB : 0);
/** MAX_PLAYERS 22 gives 20 lanes a server: SERVERS_PER_KEY 2 spreads a key from 20 trials queued (as `scheduler-spread.test.ts`). */
const SPREAD_ENV = { MINE_AI_SCENARIO_MAX_PLAYERS: "22", MINE_AI_SCENARIO_FRESH_SERVER_LANES: "20", MINE_AI_SCENARIO_SERVERS_PER_KEY: "2", MINE_AI_SCENARIO_TARGET_START: "60" };

test("two lane servers admitted in one spread both reserve the world: each request carries its size, both readings hold it while they start, and one copy ending gives only its own 440 MB back to the sample's ledger", async () => {
  const rig = new SchedulerRig(SPREAD_ENV, { worldMbFor });
  let open!: () => void;
  rig.factory.startGate = new Promise<void>(resolve => { open = resolve; });
  rig.holdArrangements();
  rig.submit(lanes(20));
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.pool.list().map(server => server.id), ["s1", "s2"]);
  assert.deepEqual(rig.factory.requests.map(request => request.worldMb), [WORLD_MB, WORLD_MB]);
  assert.deepEqual(rig.pool.readings().map(reading => reading.worldPendingMb), [WORLD_MB, WORLD_MB]);
  const ledgerBefore = rig.scheduler.sampleReport()!.ledgerMb;
  // The first server's copy ends before it is ready: its reading carries 0, the other's still holds the world.
  rig.factory.requests[0]!.onWorldCopied?.();
  assert.deepEqual(rig.pool.readings().map(reading => reading.worldPendingMb ?? 0), [0, WORLD_MB]);
  assert.equal(rig.scheduler.sampleReport()!.ledgerMb - ledgerBefore, WORLD_MB, "one world back in the ledger");
  open();
  await rig.settle();
});

test("the second server of a spread needs the first one's pending world and its own: refused 1 MB short, started at the exact room", async () => {
  const { config } = new SchedulerRig();
  // After the first server starts the ledger holds its growth, its trial's client and its pending world; the second then needs client, heap, its own world and the margin.
  const growth = config.sharedHeapMb + config.serverOverheadMb;
  const secondServerRoom = growth + config.clientMemMb + WORLD_MB + config.clientMemMb + config.sharedHeapMb + WORLD_MB + config.serverMemMarginMb;
  const serversAt = async (memAvailableMb: number) => {
    const rig = new SchedulerRig(SPREAD_ENV, { worldMbFor });
    rig.factory.startGate = new Promise<void>(() => {});
    rig.holdArrangements();
    rig.submit(lanes(20));
    rig.sample({ memAvailableMb });
    await rig.settle();
    return rig.pool.list().length;
  };
  assert.equal(await serversAt(secondServerRoom - 1), 1);
  assert.equal(await serversAt(secondServerRoom), 2);
});

test("a new lane server needs room for its world: a ledger 1 MB short starts none, the exact room starts one; no template starts it as before", async () => {
  const need = rigNeed();
  const short = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "60" }, { worldMbFor });
  short.submit(lanes(1));
  short.sample({ memAvailableMb: need + WORLD_MB - 1 });
  await short.settle();
  assert.equal(short.pool.list().length, 0);
  const exact = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "60" }, { worldMbFor });
  exact.submit(lanes(1));
  exact.sample({ memAvailableMb: need + WORLD_MB });
  await exact.settle();
  assert.equal(exact.pool.list().length, 1);
  const bare = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "60" });
  bare.submit(lanes(1));
  bare.sample({ memAvailableMb: need });
  await bare.settle();
  assert.equal(bare.pool.list().length, 1, "no worldMbFor dep: the old reserve");
});

test("a server that gets no template copy reserves no world: one of its own, or a lane server of a world that is not the template's", async () => {
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_TARGET_START: "60" }, { worldMbFor });
  rig.submit([{ name: "own", placement: ownPlacement("own:a") }]);
  rig.submit([{ name: "default-world", placement: lanePlacement("k2"), world: { type: "default" } }]);
  // A new server starts at most once per sample.
  rig.sample();
  await rig.settle();
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.factory.requests.map(request => request.worldMb ?? 0), [0, 0]);
});

/** What a new lane server with its client needs of the ledger with no world: client, heap and margin. */
function rigNeed(): number {
  const { config } = new SchedulerRig();
  return config.clientMemMb + config.sharedHeapMb + config.serverMemMarginMb;
}
