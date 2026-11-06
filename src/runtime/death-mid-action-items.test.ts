import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Action } from "../actions/action.js";
import { dropItemResultSchema } from "../actions/drop-item/contract.js";
import { useBucketResultSchema } from "../actions/use-bucket/contract.js";
import { useContainerResultSchema } from "../actions/use-container/contract.js";
import { CLICK_WALL_MS } from "../actions/use-container/window-answer.js";
import { carriedCountField } from "../test-support/carried-counts.js";
import { type FakeClock, type FakeHarness, createFakeBot, createFakeClock, itemOf } from "../test-support/fake-bot/index.js";
import { monotonicNow } from "../utils/index.js";
import { createMinecraftRuntime, type MinecraftRuntime } from "./minecraft-runtime.js";

// A death in the middle of a resumable item action, through the runtime on the shared fake (plan p4-01b task 3): the
// death cancels the request within the action's own bound, the request after the respawn starts from the world's
// state, and 20 bots with the same action keep their own records while one of them dies.
//
// The death is the measured one (`fake-bot-combat.ts` `sendHealth`: the cause packet, the inventory clear, health 0;
// then health 20 and `spawn`). Each action's first wait is where the test kills the bot:
//   use_container  the first window click reached the server
//   drop_item      the first toss resolved (the walk away and the pickup check are next)
//   drop_item pit  the first dig started
//   use_bucket     the bucket use reached the server
// The runtime runs the actions with their production dependencies on the fake: navigation, digging, placing, tossing.

const CHEST = "1,64,1";
const WATER = "3,63,0";
const BOTS = 20;
const DYING_BOT = 7;
/** What the respawned bot carries again: not the count it started with, so a credit from before the death shows. */
const REGIVEN = 7;
const MAIN_SLOT = 9;
const HOTBAR_SLOT = 36;
const DEATH = (name: string) => ({ kind: "runtime_failure", status: "cancelled", error: `${name} died.` });
const TEST_MS = 90_000;
/** The longest a whole request may take in real time: the toss and pickup check alone take 3 s. */
const REQUEST_MS = 30_000;
/** `drop-item.ts` `PICKUP_WAIT_MS` (:57): the longest the action waits after its toss. */
const DROP_PICKUP_WAIT_MS = 3_000;
/** `world/item-use.ts` `DEFAULT_TIMEOUT_TICKS` (:48), 40 ticks of 50 ms: the longest a bucket use waits for the server. */
const BUCKET_USE_MS = 2_000;
const SERVER_CATCH_UP_MS = 100;
const SPAWN_OFFSET = 8;

interface Rig {
  readonly harness: FakeHarness;
  readonly runtime: MinecraftRuntime;
  readonly name: string;
}

function actionOf(runtime: MinecraftRuntime, name: string): Action {
  const found = runtime.actions.find((action) => action.name === name);
  assert.ok(found, `the runtime has no action ${name}`);
  return found;
}

async function rigOn(t: test.TestContext, harness: FakeHarness): Promise<Rig> {
  const name = harness.bot.username;
  harness.bot.setMaxListeners(40); // as the runtime host allows its observers (`runtime-host.ts`)
  const runtime = await createMinecraftRuntime(harness.bot, {
    botData: { storage: { kind: "temporary" }, identity: { worldId: "death-mid-action-items", scope: { kind: "bot", botId: name } } },
  });
  t.after(() => runtime.close());
  return { harness, runtime, name };
}

/** Moves the shared fake clock in slices until every run has settled, bounded in real time. */
async function settledAll<T>(clock: FakeClock, runs: readonly Promise<T>[], boundMs: number): Promise<T[]> {
  let pending = runs.length;
  for (const run of runs) void run.then(() => void (pending -= 1), () => void (pending -= 1));
  const startedAt = monotonicNow();
  while (pending > 0) {
    if (monotonicNow() - startedAt > boundMs) throw new Error(`${pending} of ${runs.length} runs did not settle within ${boundMs} ms of real time`);
    await clock.advance(50);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return Promise.all(runs);
}

/**
 * One request of `rig`, run to its end; the time it took in real ms (the drop's waits) and in fake-clock ms (the waits on
 * server ticks and physics ticks: a click, a bucket use). An action's own bound is read on the clock its wait runs on.
 */
async function ran(rig: Rig, action: string, request: object, boundMs: number): Promise<{ readonly result: unknown; readonly elapsedMs: number; readonly clockMs: number }> {
  const startedAt = monotonicNow();
  const clockStartedAt = rig.harness.clock.now();
  const [outcome] = await settledAll(rig.harness.clock, [rig.runtime.run(actionOf(rig.runtime, action), request)], boundMs);
  const elapsedMs = monotonicNow() - startedAt;
  const clockMs = rig.harness.clock.now() - clockStartedAt;
  await rig.harness.clock.advance(SERVER_CATCH_UP_MS); // the server's last answer (a window close) lands one slice after the call that sent it
  return { result: outcome!.result, elapsedMs, clockMs };
}

/** Calls `die` once, the first time `arm`'s hook fires. */
function once(die: () => void): () => void {
  let dead = false;
  return () => {
    if (dead) return;
    dead = true;
    die();
  };
}

const kill = (harness: FakeHarness) => harness.combat.setHealth(0);

/**
 * STOPGAP (waits for the fake's measured death to include the respawn's `position` packet): the server puts the respawned
 * player at its spawn with a `position` packet, and Mineflayer's physics stays off after a death until it arrives
 * (`physics.js:480-484` `shouldUsePhysics`, the fake mirrors it in `fake-bot-physics.ts`); `sendHealth(20, 20)` alone
 * sends none, so no action that waits for ticks or walks would finish. The packet itself is unmeasured on the real
 * server (no contract check yet; Mineflayer's `physics.js:426-430` delays its forced position after a death, so it
 * expects one). The bot respawns at its spawn, 8 blocks from where it died: what it tossed before the death lies
 * behind it, and is not picked up again.
 */
function respawn(harness: FakeHarness): void {
  harness.combat.setHealth(20, 20);
  harness.server.sendPosition(harness.bot.entity.position.offset(SPAWN_OFFSET, 0, 0));
}

const isCancelled = (result: unknown) => (result as { kind?: string; status?: string }).kind === "runtime_failure" && (result as { status?: string }).status === "cancelled";

/**
 * The server's slot redraw: `count` of `name` in `slot`. A fixed slot, not `setCarriedCount` (which fills the hotbar
 * first): the item in hand is refused by `drop_item` (`DROP_HELD`), so a drop test keeps its stacks in the main slots.
 */
function give(harness: FakeHarness, slot: number, name: string, count: number): void {
  (harness.bot.inventory.updateSlot as (slot: number, item: unknown) => void).call(harness.bot.inventory, slot, itemOf(harness.bot.registry, name, count));
}

const carriedOf = (harness: FakeHarness, name: string) => carriedCountField(harness, name).count;

/**
 * STOPGAP 1 (waits for the fake to answer a finished dig with the server's `block_change`; `bot.ts` `#awaitServerBreak`
 * needs the packet, and the real server sends it): the cell becomes air for the client, as the server's packet would
 * say. Returns the cells the server broke, in order.
 */
function serverAnswersBreaks(harness: FakeHarness): Vec3[] {
  const { bot, server } = harness;
  const broken: Vec3[] = [];
  server.onPacket("block_dig", (data) => {
    const { status, location } = data as { status: number; location: { x: number; y: number; z: number } };
    if (status !== 2) return;
    broken.push(new Vec3(location.x, location.y, location.z));
    server.answer(() => bot._client.emit("block_change", { location: { x: location.x, y: location.y, z: location.z }, type: 0 }));
  });
  return broken;
}

/**
 * STOPGAP 2 (waits for the fake to throw a toss into the pit; the shared fake drops the item at the bot's eye, where it is
 * picked up again): a toss over the pit lands in the lowest cell the server broke, one item entity that nobody picks up
 * (`pitWorld` of `drop-item-fixtures.test.ts` does the same).
 */
function tossesLandInThePit(harness: FakeHarness, broken: readonly Vec3[]): void {
  const { bot, inventory, entities } = harness;
  let landed = 0;
  const land = (name: string, count: number) => {
    const bottom = broken.reduce((lowest, cell) => (cell.y < lowest.y ? cell : lowest));
    entities.spawn({ id: 77 + landed++, name: "item", position: bottom.offset(0.5, 0.2, 0.5), item: { name, count }, pickupDelayTicks: 32_767 });
  };
  bot.tossStack = async (stack) => {
    const { name, count } = stack;
    inventory.tossStack(stack);
    land(name, count);
  };
  bot.toss = async (type, _metadata, count) => {
    inventory.toss(type, count ?? null);
    land(bot.registry.items[type]?.name ?? "", count ?? 0);
  };
}

interface ItemCase {
  readonly title: string;
  readonly action: string;
  /** The action's own bound on its first wait, in ms of real time: a cancel by death ends well before it. */
  readonly boundMs: number;
  /** The clock the action's wait runs on: `real` (the drop's `sleepMs`), or the fake clock (a window click, a physics tick). The fake clock runs far faster than real time while a test drives it. */
  readonly boundOn: "real" | "fake";
  /** Bot `index` in its own world on `clock`, carrying `10 + index` of its item. */
  world(index: number, clock: FakeClock): FakeHarness;
  request(index: number): object;
  /** The bot dies the first time it reaches its first wait. */
  armDeath(harness: FakeHarness, die: () => void): void;
  /** The respawned bot (empty inventory) carries `REGIVEN` again; `again` runs the same request; it started from the world after the respawn. */
  afterRespawn(harness: FakeHarness, again: () => Promise<unknown>): Promise<void>;
  /** Bot `index` finished its own request with its own counts. */
  finished(result: unknown, harness: FakeHarness, index: number): void;
}

const chestCount = (harness: FakeHarness) => harness.windows.containerStacks(CHEST).reduce((total, { count }) => total + count, 0);

const CASES: readonly ItemCase[] = [
  {
    title: "use_container",
    action: "use_container",
    boundMs: CLICK_WALL_MS,
    boundOn: "fake",
    world: (index, clock) =>
      createFakeBot({ clock, username: `Chest${index}`, position: new Vec3(0.5, 64, 0.5), simulatePhysics: true, cells: { [CHEST]: "chest" }, containers: { [CHEST]: {} }, slots: { [MAIN_SLOT]: { name: "cobblestone", count: 10 + index } } }),
    request: (index) => ({ operation: "deposit", x: 1, y: 64, z: 1, items: [{ item_name: "cobblestone", count: 3 + index }] }),
    armDeath: (harness, die) => void harness.windows.onClickReceived(once(die)),
    async afterRespawn(harness, again) {
      give(harness, MAIN_SLOT, "cobblestone", REGIVEN);
      const chestBefore = chestCount(harness);
      const parsed = useContainerResultSchema.parse(await again());
      assert.equal(parsed.status, "succeeded", JSON.stringify(parsed));
      if (parsed.container?.operation !== "deposit") assert.fail("expected deposit evidence");
      assert.equal(parsed.container.transfers[0]?.transferred, 3, "the deposit counts what this request moved, not what the dead request moved");
      assert.equal(chestCount(harness), chestBefore + 3);
      assert.equal(carriedOf(harness, "cobblestone"), REGIVEN - 3);
    },
    finished(result, harness, index) {
      const parsed = useContainerResultSchema.parse(result);
      assert.equal(parsed.status, "succeeded", `bot ${index}: ${JSON.stringify(parsed)}`);
      if (parsed.container?.operation !== "deposit") assert.fail("expected deposit evidence");
      assert.equal(parsed.container.transfers[0]?.transferred, 3 + index);
      assert.equal(chestCount(harness), 3 + index, `bot ${index}'s chest`);
      assert.equal(carriedOf(harness, "cobblestone"), 7);
    },
  },
  {
    title: "drop_item",
    action: "drop_item",
    boundMs: DROP_PICKUP_WAIT_MS,
    boundOn: "real",
    world: (index, clock) =>
      createFakeBot({ clock, username: `Drop${index}`, position: new Vec3(0.5, 64, 0.5), simulatePhysics: true, slots: { [MAIN_SLOT]: { name: "cobblestone", count: 10 + index } } }),
    request: (index) => ({ items: [{ item_name: "cobblestone", count: 3 + index }] }),
    armDeath(harness, die) {
      const dieOnce = once(die);
      const { bot } = harness;
      const tossStack = bot.tossStack.bind(bot);
      bot.tossStack = async (stack) => {
        await tossStack(stack);
        dieOnce();
      };
      const toss = bot.toss.bind(bot);
      bot.toss = async (type, metadata, count) => {
        await toss(type, metadata, count);
        dieOnce();
      };
    },
    async afterRespawn(harness, again) {
      give(harness, MAIN_SLOT, "cobblestone", REGIVEN);
      const parsed = dropItemResultSchema.parse(await again());
      assert.equal(parsed.status, "succeeded", JSON.stringify(parsed));
      assert.deepEqual(
        parsed.drop.dropped.map(({ carriedBefore, dropped, carriedAfter }) => ({ carriedBefore, dropped, carriedAfter })),
        [{ carriedBefore: REGIVEN, dropped: 3, carriedAfter: REGIVEN - 3 }],
        "the counts are the respawned bot's, not the toss before the death",
      );
    },
    finished(result, _harness, index) {
      const parsed = dropItemResultSchema.parse(result);
      assert.equal(parsed.status, "succeeded", `bot ${index}: ${JSON.stringify(parsed)}`);
      assert.deepEqual(
        parsed.drop.dropped.map(({ carriedBefore, dropped, carriedAfter }) => ({ carriedBefore, dropped, carriedAfter })),
        [{ carriedBefore: 10 + index, dropped: 3 + index, carriedAfter: 7 }],
      );
    },
  },
  {
    title: "drop_item into a hole (the held pit)",
    action: "drop_item",
    boundMs: DROP_PICKUP_WAIT_MS,
    boundOn: "real",
    world(index, clock) {
      const harness = createFakeBot({
        clock, username: `Pit${index}`, position: new Vec3(0.5, 64, 0.5), simulatePhysics: true,
        slots: { [MAIN_SLOT]: { name: "dirt", count: 4 + index }, [MAIN_SLOT + 1]: { name: "cobblestone", count: 6 } },
      });
      tossesLandInThePit(harness, serverAnswersBreaks(harness));
      return harness;
    },
    request: () => ({ items: [{ item_name: "dirt" }], in_a_hole: true }),
    armDeath(harness, die) {
      const dieOnce = once(die);
      harness.server.onPacket("block_dig", (data) => void ((data as { status: number }).status === 0 && dieOnce()));
    },
    async afterRespawn(harness, again) {
      give(harness, MAIN_SLOT, "dirt", REGIVEN);
      give(harness, MAIN_SLOT + 1, "cobblestone", 6);
      const parsed = dropItemResultSchema.parse(await again());
      assert.equal(parsed.status, "succeeded", JSON.stringify(parsed));
      assert.deepEqual(
        parsed.drop.dropped.map(({ carriedBefore, dropped }) => ({ carriedBefore, dropped })),
        [{ carriedBefore: REGIVEN, dropped: REGIVEN }],
        "the counts are the respawned bot's",
      );
      assert.equal(parsed.drop.hole?.y, 62, "the pit is planned from the world's blocks, two cells below the ground");
      assert.ok(Math.abs((parsed.drop.hole?.x ?? 0) - harness.bot.entity.position.x) <= 5, "beside the bot's new spot, not the old one");
      assert.equal(parsed.drop.holeClosure?.placed, 2, "the pit is plugged");
    },
    finished(result, _harness, index) {
      const parsed = dropItemResultSchema.parse(result);
      assert.equal(parsed.status, "succeeded", `bot ${index}: ${JSON.stringify(parsed)}`);
      assert.deepEqual(
        parsed.drop.dropped.map(({ carriedBefore, dropped }) => ({ carriedBefore, dropped })),
        [{ carriedBefore: 4 + index, dropped: 4 + index }],
      );
      assert.equal(parsed.drop.holeClosure?.placed, 2);
    },
  },
  {
    title: "use_bucket",
    action: "use_bucket",
    boundMs: BUCKET_USE_MS,
    boundOn: "fake",
    world: (index, clock) =>
      createFakeBot({ clock, username: `Bucket${index}`, position: new Vec3(0.5, 64, 0.5), simulatePhysics: true, cells: { [WATER]: "water" }, slots: { [HOTBAR_SLOT]: { name: "bucket", count: 1 } } }),
    request: () => ({ action: "fill", liquid: "water", x: 3, y: 63, z: 0 }),
    armDeath: (harness, die) => void harness.server.onPacket("use_item", once(die)),
    async afterRespawn(harness, again) {
      give(harness, HOTBAR_SLOT, "bucket", 1);
      const parsed = useBucketResultSchema.parse(await again());
      assert.equal(parsed.status, "succeeded", JSON.stringify(parsed));
      assert.deepEqual([parsed.bucket.heldBefore, parsed.bucket.heldAfter, parsed.bucket.targetBefore, parsed.bucket.targetAfter], ["bucket", "water_bucket", "water", "air"]);
    },
    finished(result, harness, index) {
      const parsed = useBucketResultSchema.parse(result);
      assert.equal(parsed.status, "succeeded", `bot ${index}: ${JSON.stringify(parsed)}`);
      assert.equal(parsed.bucket.heldAfter, "water_bucket");
      assert.equal(harness.bot.blockAt(new Vec3(3, 63, 0))?.name, "air");
    },
  },
];

for (const case_ of CASES) {
  test(`${case_.title}: a death at its first wait ends it as cancelled by death within its own bound`, { timeout: TEST_MS }, async (t) => {
    const harness = case_.world(0, createFakeClock({ mode: "manual" }));
    const rig = await rigOn(t, harness);
    case_.armDeath(harness, () => kill(harness));

    const { result, elapsedMs, clockMs } = await ran(rig, case_.action, case_.request(0), case_.boundMs);

    assert.deepEqual(result, DEATH(rig.name));
    const tookMs = case_.boundOn === "real" ? elapsedMs : clockMs;
    assert.ok(tookMs < case_.boundMs, `the cancel took ${tookMs} ms of ${case_.boundOn} time, past the action's own ${case_.boundMs} ms`);
    assert.equal(rig.runtime.status().busy, false);
  });

  test(`${case_.title}: the request after the respawn credits nothing from before the death`, { timeout: TEST_MS }, async (t) => {
    const harness = case_.world(0, createFakeClock({ mode: "manual" }));
    const rig = await rigOn(t, harness);
    case_.armDeath(harness, () => kill(harness));
    const request = case_.request(0);
    assert.ok(isCancelled((await ran(rig, case_.action, request, case_.boundMs)).result), "the death ended the first request");

    respawn(harness);
    await case_.afterRespawn(harness, async () => (await ran(rig, case_.action, request, REQUEST_MS)).result);
  });

  test(`${case_.title}: ${BOTS} bots keep their own records`, { timeout: TEST_MS }, async (t) => {
    const clock = createFakeClock({ mode: "manual" });
    const rigs: Rig[] = [];
    for (let index = 0; index < BOTS; index += 1) rigs.push(await rigOn(t, case_.world(index, clock)));
    const dying = rigs[DYING_BOT]!;
    case_.armDeath(dying.harness, () => kill(dying.harness));

    const results = await settledAll(
      clock,
      rigs.map((rig, index) => rig.runtime.run(actionOf(rig.runtime, case_.action), case_.request(index))),
      TEST_MS - 10_000,
    );

    rigs.forEach((rig, index) => {
      if (index === DYING_BOT) assert.ok(isCancelled(results[index]!.result), `${rig.name} was cancelled by its death`);
      else case_.finished(results[index]!.result, rig.harness, index);
    });
  });
}
