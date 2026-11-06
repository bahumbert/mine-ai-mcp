// Spec 2026-11-06-p4-01 D9 (plan b task 4): the body's resumable actions (eat_food, build_structure, the held crafting
// table of craft_item, equip, sleep) under death, through the runtime that owns the death cancel
// (`minecraft-runtime.ts` `observePlayerEvents`), on the shared fake's measured death (`fake-bot-combat.ts`
// `sendHealth`: the cause packet, the inventory cleared, `death`; then `spawn` at full health).
// Each action is a `Scene`: a bot on the fake with one wait the test holds open, the request, and what the finished
// request reports about the bot's own counts.
import assert from "node:assert/strict";
import test from "node:test";
import { readRecentEventsResultSchema } from "../actions/read-recent-events/contract.js";
import { CarriedCounts } from "../test-support/carried-counts.js";
import { craftingBot } from "../test-support/crafting.js";
import { type FakeClock, type FakeHarness, createFakeBot, createFakeClock, flush } from "../test-support/fake-bot/index.js";
import { structureWorld } from "../test-support/structure-world.js";
import { monotonicNow } from "../utils/index.js";
import { createMinecraftRuntime, type MinecraftRuntime } from "./minecraft-runtime.js";

interface Scene {
  readonly harness: FakeHarness;
  readonly actionName: string;
  readonly input: unknown;
  /** Clock ms the cancel may take: the action's own timeout where it has one, else one second. */
  readonly boundMs: number;
  /** The request sits at the wait the test holds open. */
  reachedWait(): boolean;
  /** The held wait ends as the server's answer would. */
  proceed(): void;
  /** What the dead bot lacks after the respawn (the death cleared the inventory): other counts than the first life's. */
  restock(): void;
  /** What a finished request says about this bot's counts. */
  report(result: unknown): unknown;
  /** `report` of a request that started from the first life's counts. */
  readonly firstLife: unknown;
  /** `report` of the same request after `restock()`. */
  readonly afterRespawn: unknown;
}

type SceneFactory = (clock: FakeClock, index: number) => Scene;

/**
 * Holds the `nth` call of a method until `proceed()`, then runs the method: the server's answer that has not come yet.
 * `timeout`: Mineflayer's own limit for that answer, after which the call rejects with its error and never runs.
 */
function holdNthCall<Args extends unknown[], Result>(
  original: (...args: Args) => Promise<Result>,
  nth: number,
  timeout?: { readonly ms: number; readonly message: string },
) {
  let calls = 0;
  let held = false;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const unanswered = (): Promise<never> =>
    new Promise((_resolve, reject) => timeout && setTimeout(() => reject(new Error(timeout.message)), timeout.ms));
  return {
    held: async (...args: Args): Promise<Result> => {
      calls += 1;
      if (calls === nth) { held = true; await Promise.race([gate, unanswered()]); }
      return original(...args);
    },
    reached: () => held,
    proceed: () => open(),
  };
}

/** Sets the carried count of each named item, as the server's slot updates would. */
function carry(harness: FakeHarness, counts: Readonly<Record<string, number>>): void {
  const carried = new CarriedCounts(harness.inventory, harness.bot.registry);
  for (const [name, count] of Object.entries(counts)) carried.set(harness.bot.registry.itemsByName[name]!.id, count);
}

/** Mineflayer waits this long for the server's block update after a placement (`place_block.js:75`, :81). */
const PLACE_ANSWER_TIMEOUT = { ms: 5_000, message: "Event blockUpdate did not fire within timeout of 5000ms" };

/** Mineflayer waits this long for the server to seat the bot after a bed use (`bed.js:157-160`). */
const SLEEP_ANSWER_TIMEOUT = { ms: 3_000, message: "bot is not sleeping" };

/**
 * A window click or craft the server never answers. Mineflayer's limits for these (`inventory.js:17`, `:504`, `:713`)
 * were not traced to `equip` and `craft`, so the test lets the call fail after this long: unmeasured, a stopgap bound
 * for a wait the action must not outlive.
 */
const UNANSWERED_CLICK_TIMEOUT = { ms: 3_000, message: "the server never answered the window click" };

/** The fake clock moves in slices of this length: a wait that started inside a slice ends up to one slice later. */
const CLOCK_SLICE_MS = 50;

/**
 * Plan b task 8: a pending Mineflayer call (a window click, a bed use, a placement) the server never answers does not
 * hold the death cancel back; the action races it against its signal, so the cancel comes within this much clock time.
 */
const DEATH_CANCEL_BOUND_MS = 1_000;

/**
 * The 20-runtime tests take 1.7 s (eat_food) to 6.2 s (build_structure, craft_item) of wall time on this machine (2026-11-06,
 * WSL on the D: mount), against the runner's 5 s default: each builds 20 runtimes, so they carry their own bound.
 */
const TWENTY_BOTS_TIMEOUT_MS = 20_000;

const resultOf = (output: { readonly result: unknown }) => output.result as Record<string, any>;

/** Eats `cooked_beef`: the bite (`bot.consume`) is the held wait. Carries 2 + index, then 5 + index after a respawn. */
const eatScene: SceneFactory = (clock, index) => {
  const harness = createFakeBot({ username: `Eater${index}`, clock, food: 10, carried: { cooked_beef: 2 + index } });
  const { bot } = harness;
  const beef = bot.registry.itemsByName.cooked_beef!.id;
  const counts = new CarriedCounts(harness.inventory, bot.registry);
  const bite = holdNthCall(async () => { counts.set(beef, (counts.get(beef) ?? 0) - 1); bot.food = 18; }, 1);
  bot.consume = bite.held;
  const evidence = (carried: number) => ({ before: carried, after: carried - 1 });
  return {
    harness, actionName: "eat_food", input: { food_name: "cooked_beef" }, boundMs: 2_500, // CONSUMPTION_SETTLE_MS, eat-food.ts:24
    reachedWait: bite.reached, proceed: bite.proceed,
    restock: () => carry(harness, { cooked_beef: 5 + index }),
    report: (result) => ({ before: resultOf({ result }).eating.inventoryBefore, after: resultOf({ result }).eating.inventoryAfter }),
    firstLife: evidence(2 + index), afterRespawn: evidence(5 + index),
  };
};

/**
 * Equips a helmet, then a second piece (a chestplate for even bots, leggings for odd ones): the second `bot.equip` is
 * held, so the helmet is on when the bot dies.
 */
const equipScene: SceneFactory = (clock, index) => {
  const second = index % 2 === 0 ? "iron_chestplate" : "iron_leggings";
  const harness = createFakeBot({ username: `Wearer${index}`, clock, slots: { 9: { name: "iron_helmet" }, 10: { name: second } } });
  const { bot } = harness;
  const equipped: string[] = [];
  const equipOwn = bot.equip.bind(bot);
  const held = holdNthCall(async (...args: Parameters<typeof bot.equip>) => {
    const [item] = args;
    equipped.push(typeof item === "number" ? bot.registry.items[item]!.name : item.name);
    return equipOwn(...args);
  }, 2, UNANSWERED_CLICK_TIMEOUT);
  bot.equip = held.held;
  const worn = { equips: ["iron_helmet", second], states: [true, true] };
  return {
    harness, actionName: "equip", input: { items: [{ item_name: "iron_helmet" }, { item_name: second }] }, boundMs: DEATH_CANCEL_BOUND_MS,
    reachedWait: held.reached, proceed: held.proceed,
    restock: () => { equipped.length = 0; carry(harness, { iron_helmet: 1, [second]: 1 }); },
    // Every item is worn by an equip of this life: the first life's helmet is not counted as worn now.
    report: (result) => ({ equips: [...equipped], states: resultOf({ result }).equip.equipped.map((entry: { equipped: boolean }) => entry.equipped) }),
    firstLife: worn, afterRespawn: worn,
  };
};

/**
 * Sleeps in a bed 2 or 3 blocks east of the bot at night: the bed use (`bot.sleep`) is the held wait. A death asleep is
 * not tested: damage wakes a sleeper before she dies (vanilla `ServerPlayer.hurt`), which the fake's `sendHealth` does
 * not send, so `isSleeping` would stay true through the respawn (unmeasured; a contract check first).
 */
const sleepScene: SceneFactory = (clock, index) => {
  const bedX = 2 + (index % 2);
  const harness = createFakeBot({
    username: `Sleeper${index}`, clock, position: { x: 0, y: 64, z: 0 }, server: { timeOfDay: 14_000 },
    cells: {
      [`${bedX},64,0`]: { name: "white_bed", properties: { facing: "east", occupied: "false", part: "foot" } },
      [`${bedX + 1},64,0`]: { name: "white_bed", properties: { facing: "east", occupied: "false", part: "head" } },
    },
  });
  const { bot } = harness;
  let sleeps = 0;
  const sleepOwn = bot.sleep.bind(bot);
  const bedUse = holdNthCall(async (...args: Parameters<typeof bot.sleep>) => { sleeps += 1; return sleepOwn(...args); }, 1, SLEEP_ANSWER_TIMEOUT);
  bot.sleep = bedUse.held;
  // The bot sleeps once in the run (the first life's bed use never reached the server): a leaked "slept already" would make it zero.
  const slept = { bedX, sleeps: 1 };
  return {
    harness, actionName: "sleep", input: {}, boundMs: DEATH_CANCEL_BOUND_MS,
    reachedWait: bedUse.reached, proceed: bedUse.proceed,
    restock: () => {},
    report: (result) => ({ bedX: resultOf({ result }).sleep?.bedPosition?.x ?? JSON.stringify(result), sleeps }),
    firstLife: slept, afterRespawn: slept,
  };
};

/** Builds a wall of 3 or 4 cobblestone cells from x 1 (all within reach, no walking): the third block's placement is held. */
const buildScene: SceneFactory = (clock, index) => {
  const length = 3 + (index % 2);
  const scene = structureWorld({ clock, carried: { cobblestone: 64 } });
  const { harness } = scene;
  const place = holdNthCall(harness.bot._placeBlockWithOptions.bind(harness.bot), 3, PLACE_ANSWER_TIMEOUT);
  harness.bot._placeBlockWithOptions = place.held;
  const wall = Array.from({ length }, (_, offset) => ({ x: 1 + offset, y: 64, z: 0, block_name: "cobblestone" }));
  return {
    harness, actionName: "build_structure", input: { blocks: wall }, boundMs: DEATH_CANCEL_BOUND_MS,
    reachedWait: place.reached, proceed: place.proceed,
    restock: () => carry(harness, { cobblestone: 64 }),
    report: (result) => ({ cells: resultOf({ result }).structure.cells, correct: resultOf({ result }).structure.correct, placed: resultOf({ result }).structure.placed }),
    firstLife: { cells: length, correct: length, placed: length },
    // Two cells of the first life stand in the world: the request plans from them and places the rest.
    afterRespawn: { cells: length, correct: length, placed: length - 2 },
  };
};

/** Crafts `1 + index % 3` stone pickaxes with a carried table the request sets down: its first craft is held. */
const craftScene: SceneFactory = (clock, index) => {
  const pickaxes = 1 + (index % 3);
  const { bot, harness } = craftingBot({ crafting_table: 1, cobblestone: 3 * pickaxes, stick: 2 * pickaxes }, false, [], { clock });
  const craft = holdNthCall(bot.craft.bind(bot), 1, UNANSWERED_CLICK_TIMEOUT);
  bot.craft = craft.held;
  return {
    harness, actionName: "craft_item", input: { items: [{ item_name: "stone_pickaxe", count: pickaxes }] }, boundMs: DEATH_CANCEL_BOUND_MS,
    reachedWait: craft.reached, proceed: craft.proceed,
    // Materials for one pickaxe only; the first life's table (set down before the held craft) is not owned by the new request.
    restock: () => carry(harness, { crafting_table: 1, cobblestone: 3, stick: 2 }),
    report: (result) => ({ gained: resultOf({ result }).craft.items[0].gained }),
    firstLife: { gained: pickaxes }, afterRespawn: { gained: 1 },
  };
};

const SCENES: Readonly<Record<string, SceneFactory>> = {
  eat_food: eatScene, equip: equipScene, sleep: sleepScene, build_structure: buildScene, "craft_item (held table)": craftScene,
};

/** A runtime on the scene's bot, its bot data in memory, closed with `closing` (declared after the clock's `using`, so it closes first). */
async function runtimeOn(closing: AsyncDisposableStack, scene: Scene): Promise<MinecraftRuntime> {
  scene.harness.bot.setMaxListeners(40); // as the runtime host allows its observers (`runtime-host.ts`)
  const runtime = await createMinecraftRuntime(scene.harness.bot, {
    botData: {
      storage: { kind: "temporary" },
      identity: { worldId: "death-mid-action-body", scope: { kind: "bot", botId: scene.harness.bot.username } },
    },
  });
  closing.defer(() => runtime.close());
  return runtime;
}

function actionNamedIn(runtime: MinecraftRuntime, name: string) {
  const action = runtime.actions.find((candidate) => candidate.name === name);
  assert.ok(action, `the runtime has no action ${name}`);
  return action;
}

function startRequest(runtime: MinecraftRuntime, scene: Scene) {
  return runtime.run(actionNamedIn(runtime, scene.actionName), scene.input);
}

/** Moves the clock in slices until every scene's request sits at its held wait. */
async function untilAtWait(clock: FakeClock, scenes: readonly Scene[]): Promise<void> {
  for (let slice = 0; slice < 400 && !scenes.every((scene) => scene.reachedWait()); slice += 1) {
    await flush();
    await clock.advance(50);
  }
  assert.ok(scenes.every((scene) => scene.reachedWait()), "every request reaches its held wait");
}

/** The server kills the bot (`/kill`): the measured death, then the respawn at full health. */
const die = (scene: Scene) => scene.harness.combat.setHealth(0);
/**
 * Full health, then the server's position for the new life (the fake's `sendPosition`; physics returns 1.5 s later,
 * `fake-bot-physics.ts`, `physics.js:429`). Stopgap: the real server's respawn packets are not measured by a contract
 * check; `sendHealth` alone leaves the fake's physics off, so a look (the bed use) would hang.
 */
async function respawn(clock: FakeClock, scene: Scene): Promise<void> {
  scene.harness.combat.setHealth(20, 20);
  scene.harness.server.sendPosition(scene.harness.bot.entity.position);
  await clock.advance(2_000);
}

for (const [label, make] of Object.entries(SCENES)) {
  test(`${label}: a death at its first wait ends it as cancelled by death within its own bound`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    await using closing = new AsyncDisposableStack();
    const scene = make(clock, 0);
    const runtime = await runtimeOn(closing, scene);
    const running = startRequest(runtime, scene);
    await untilAtWait(clock, [scene]);

    const diedAt = monotonicNow();
    die(scene);
    const output = await clock.settle(running, scene.boundMs + CLOCK_SLICE_MS);

    assert.equal(output.result.status, "cancelled", JSON.stringify(output.result));
    assert.ok(monotonicNow() - diedAt <= scene.boundMs, `the cancel took ${monotonicNow() - diedAt} ms of clock, over ${scene.boundMs}`);
    assert.equal(runtime.status().busy, false);
    const events = await runtime.run(actionNamedIn(runtime, "read_recent_events"), {});
    const deaths = readRecentEventsResultSchema.parse(events.result).events.filter((event) => event.type === "player_death");
    assert.equal(deaths.length, 1, "the death is recorded once");
  });

  test(`${label}: the request after the respawn credits nothing from before the death`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    await using closing = new AsyncDisposableStack();
    const scene = make(clock, 0);
    const runtime = await runtimeOn(closing, scene);
    const first = startRequest(runtime, scene);
    await untilAtWait(clock, [scene]);
    die(scene);
    await clock.settle(first, scene.boundMs + CLOCK_SLICE_MS);
    await respawn(clock, scene);
    scene.restock(); // the dead life's held call is not answered: a dead body's window click is gone

    const second = await clock.settle(startRequest(runtime, scene), 60_000);

    assert.equal(second.result.status, "succeeded", JSON.stringify(second.result));
    assert.deepEqual(scene.report(second.result), scene.afterRespawn);
  });

  test(`${label}: 20 bots keep their own records`, { timeout: TWENTY_BOTS_TIMEOUT_MS }, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    await using closing = new AsyncDisposableStack();
    const scenes = Array.from({ length: 20 }, (_, index) => make(clock, index));
    const runtimes = await Promise.all(scenes.map((scene) => runtimeOn(closing, scene)));
    const running = scenes.map((scene, index) => startRequest(runtimes[index]!, scene));
    await untilAtWait(clock, scenes);

    const killed = 7;
    die(scenes[killed]!);
    for (const [index, scene] of scenes.entries()) if (index !== killed) scene.proceed();
    const outputs = await Promise.all(running.map((request) => clock.settle(request, 60_000)));

    assert.equal(outputs[killed]!.result.status, "cancelled", JSON.stringify(outputs[killed]!.result));
    for (const [index, output] of outputs.entries()) {
      if (index === killed) continue;
      assert.equal(output.result.status, "succeeded", `bot ${index}: ${JSON.stringify(output.result)}`);
      assert.deepEqual(scenes[index]!.report(output.result), scenes[index]!.firstLife, `bot ${index}`);
    }
  });
}
