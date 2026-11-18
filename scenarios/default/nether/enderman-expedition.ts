import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { droppedItemName } from "../../../src/world/item-pickup.ts";
import { declaredEntities, declaredEntitiesArranged, declaredStart, openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import { createNativeWave } from "../../src/native-wave.ts";
import { runExpeditionAction } from "../../src/expedition-action.ts";
import { judgeDrops } from "../../src/game-rate.ts";
import { waitForServerPaced } from "../../../src/world/server-paced.ts";

const position = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const damageEventSchema = z.object({ entityId: z.number(), sourceCauseId: z.number(), sourceDirectId: z.number() });
const paramsSchema = z.strictObject({
  approach: position,
  collection: z.strictObject({ drops: z.number().int().positive(), minimumDropsPerMinute: z.number().positive() }).optional(),
});
type Params = z.infer<typeof paramsSchema>;
type Wave = ReturnType<typeof createNativeWave>;
type Runtime = Awaited<ReturnType<typeof openRuntime>>;

/** Arrangement commands must visibly settle before the measured expedition begins. */
async function arranged(bot: Bot, fact: () => boolean, label: string, signal: AbortSignal): Promise<void> {
  const started = monotonicNow();
  const startAge = bot.time?.age ?? null;
  const end = await waitForServerPaced(bot, 400, { until: fact, signal });
  if (end !== "until") throw new Error(`Arrangement did not observe ${label} ${JSON.stringify({ end,
    elapsedMs: monotonicNow() - started, elapsedTicks: startAge === null || bot.time?.age == null ? null : bot.time.age - startAge })}`);
}

/** Survey the standing cells and confirm equipment before the native mobs are arranged. */
async function prepareExpedition(context: MineAiScenarioContext, params: Params, home: Vec3, endermen: ReturnType<typeof declaredEntities>): Promise<void> {
  const { bot, log } = context;
  await bot.waitForChunksToLoad();
  for (const [x, y, z] of [home.toArray(), params.approach, ...endermen.map(({ position }) => position.floored().toArray())]) {
    const feet = new Vec3(x, y, z);
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    if (floor?.boundingBox !== "block" || bot.blockAt(feet)?.boundingBox !== "empty" || bot.blockAt(feet.offset(0, 1, 0))?.boundingBox !== "empty")
      throw new Error(`Surveyed standing cell changed at ${feet}.`);
    log(`survey ${feet}: floor ${floor.name}, roof ${bot.blockAt(feet.offset(0, 2, 0))?.name}`);
  }
  if (!(await standStill(context))) throw new Error("The expedition did not settle on its surveyed starting cell.");
  await wearArmor(context);
  // Spectator inventory clicks were rejected by the server in the first batch.
  let equipmentConfirmed = false;
  const onEquipment = (message: string) => { if (message === "ENDER_EXPEDITION_ARMOR_CONFIRMED") equipmentConfirmed = true; };
  bot.on("messagestr", onEquipment);
  try {
    bot.chat('/execute if items entity @s armor.head minecraft:iron_helmet if items entity @s armor.chest minecraft:iron_chestplate if items entity @s armor.legs minecraft:iron_leggings if items entity @s armor.feet minecraft:golden_boots run tellraw @s "ENDER_EXPEDITION_ARMOR_CONFIRMED"');
    await arranged(bot, () => equipmentConfirmed, "server-confirmed expedition armor in all four slots", context.signal);
  } finally { bot.off("messagestr", onEquipment); }
  log("Server confirmed iron helmet, chestplate, leggings and golden boots equipped before native mob arrangement.");
  for (const { position } of endermen) {
    if (bot.blockAt(position.floored().offset(0, 2, 0))?.name !== "air")
      throw new Error(`Enderman lacks its third clear body block at ${position}.`);
  }
  await declaredEntitiesArranged(context);
}

/** Observe native combat and population events until the expedition ends. */
function observeExpedition(context: MineAiScenarioContext, start: Vec3, wave: Wave, died: AbortController, collection: boolean) {
  const { bot } = context;
  const pearlId = bot.registry.itemsByName.ender_pearl!.id;
  const arrowId = bot.registry.itemsByName.arrow!.id;
  const initialPearls = bot.inventory.count(pearlId, null);
  const initialArrows = bot.inventory.count(arrowId, null);
  const state = {
    pearlId, initialPearls, initialArrows, minimumArrows: initialArrows, minimumHealth: bot.health,
    collecting: false, deaths: 0, targetDeaths: 0, nativeTargetHits: 0, largeTargetDisplacements: 0,
    maximumDistanceFromHome: 0, pearlDrops: new Set<number>(),
    targetIds: new Set(Object.values(bot.entities).filter((entity) => entity.name === "enderman").map((entity) => entity.id)),
  };
  const lastPositions = new Map<number, Vec3>();
  const onDead = (entity: Bot["entity"]) => {
    if (state.targetIds.has(entity.id)) state.targetDeaths++;
    wave.death(entity.id, collection && state.collecting);
  };
  const onDeath = () => { state.deaths++; died.abort("Enderman expedition bot died"); };
  const onSpawn = (entity: Bot["entity"]) => {
    if (entity.name === "enderman") { state.targetIds.add(entity.id); wave.spawn(entity.id); }
  };
  const onTick = () => {
    wave.tick(collection && state.collecting);
    state.minimumHealth = Math.min(state.minimumHealth, bot.health);
    state.minimumArrows = Math.min(state.minimumArrows, bot.inventory.count(arrowId, null));
    state.maximumDistanceFromHome = Math.max(state.maximumDistanceFromHome, bot.entity.position.distanceTo(start));
    for (const entity of Object.values(bot.entities)) if (droppedItemName(entity) === "ender_pearl") state.pearlDrops.add(entity.id);
  };
  const onMoved = (entity: Bot["entity"]) => {
    if (entity.name !== "enderman") return;
    const before = lastPositions.get(entity.id);
    if (before && before.distanceTo(entity.position) > 4) state.largeTargetDisplacements++;
    lastPositions.set(entity.id, entity.position.clone());
  };
  bot.on("entityDead", onDead); bot.on("death", onDeath); bot.on("physicsTick", onTick);
  bot.on("entityMoved", onMoved); bot.on("entitySpawn", onSpawn);
  return { state, close() {
    bot.off("entityDead", onDead); bot.off("death", onDeath); bot.off("physicsTick", onTick);
    bot.off("entityMoved", onMoved); bot.off("entitySpawn", onSpawn);
  } };
}
type Observation = ReturnType<typeof observeExpedition>["state"];

/** Record damage before the incident history can roll over. */
function captureExpeditionHit(packet: unknown, bot: Bot, state: Observation, runtime: Runtime, log: (message: string) => void): void {
  const parsed = damageEventSchema.safeParse(packet);
  if (!parsed.success) return;
  const hit = parsed.data;
  if (state.targetIds.has(hit.entityId) && (hit.sourceCauseId === bot.entity.id + 1 || hit.sourceDirectId === bot.entity.id + 1)) state.nativeTargetHits++;
  if (hit.entityId === bot.entity.id) void runtime.captureIncident().catch((cause) => log(`Incident capture failed: ${String(cause)}`));
}

/** Run the outward journey, collection and return through production actions. */
async function travelExpedition(options: { context: MineAiScenarioContext; params: Params; home: Vec3; wave: Wave; state: Observation; runtime: Runtime; signal: AbortSignal }) {
  const { context: { log }, params, home, wave, state, runtime, signal } = options;
  const actions: { name: string; output: unknown }[] = [];
  let settledWithWavePending = false;
  const call = async (name: string, request: unknown) => {
    const action = runtime.actions.find((candidate) => candidate.name === name);
    if (!action) throw new Error(`Missing production action ${name}.`);
    const settled = await runExpeditionAction({
      name, run: () => runtime.run(action, request, signal), isWavePending: () => wave.pending,
      capture: () => runtime.captureIncident(),
      record: (output) => { actions.push({ name, output }); log(`${name}: ${JSON.stringify(output)}`); },
    });
    if (name === "collect_mob_drop") settledWithWavePending = settled.settledWithWavePending;
    return settled.output;
  };
  const started = monotonicNow();
  const startAge = options.context.bot.time?.age ?? null;
  if (startAge === null) throw new Error("Expedition setup failed: no world age heard");
  const [x, y, z] = params.approach;
  const outward = await call("navigate", { x, y, z, range: 1, dig: false, scaffold: false });
  const requested = params.collection?.drops ?? 1;
  state.collecting = true;
  const hunting = outward.result.status === "succeeded"
    ? await call("collect_mob_drop", { mob_name: "enderman", drop_name: "ender_pearl", count: requested }) : null;
  if (wave.error) throw wave.error;
  state.collecting = false;
  const returning = await call("navigate", { x: home.x, y: home.y, z: home.z, range: 1 });
  await wave.waitServerTicks(100);
  return { hunting, returning, actions, settledWithWavePending, requested, startAge,
    endAge: options.context.bot.time?.age ?? null, elapsedMs: monotonicNow() - started };
}

/** Build the completion evidence from observed inventory, health and action outcomes. */
function expeditionResult(context: MineAiScenarioContext, params: Params, start: Vec3, home: Vec3, state: Observation, trip: Awaited<ReturnType<typeof travelExpedition>>) {
  const { bot } = context;
  const gained = bot.inventory.count(state.pearlId, null) - state.initialPearls;
  const rate = judgeDrops({ gained, requested: trip.requested, startAge: trip.startAge, endAge: trip.endAge,
    minimumPerMinute: params.collection?.minimumDropsPerMinute ?? 0 });
  const remaining = bot.entity.position.distanceTo(start);
  const passed = !trip.settledWithWavePending && state.initialPearls === 0 && rate.passed && state.deaths === 0 &&
    bot.health > 0 && bot.game.dimension === "the_nether" && remaining <= 2;
  const finalArrows = bot.inventory.count(bot.registry.itemsByName.arrow!.id, null);
  const detail = JSON.stringify({
    seed: 20260906, home, approach: params.approach, dimension: bot.game.dimension, gained, collection: params.collection,
    hunting: trip.hunting, settledWithWavePending: trip.settledWithWavePending, returning: trip.returning,
    elapsedMs: trip.elapsedMs, elapsedTicks: rate.elapsedTicks, dropsPerMinute: rate.dropsPerMinute, rateFailure: rate.reason,
    nativePearlDropsObserved: state.pearlDrops.size,
    targetDeaths: state.targetDeaths, nativeTargetHits: state.nativeTargetHits, deaths: state.deaths,
    minimumHealth: state.minimumHealth, finalHealth: bot.health,
    arrowInventory: { initial: state.initialArrows, minimum: state.minimumArrows, final: finalArrows, netLoss: state.initialArrows - finalArrows, deathObserved: state.deaths > 0 },
    largeTargetDisplacements: state.largeTargetDisplacements, maximumDistanceFromHome: state.maximumDistanceFromHome,
    remaining, actions: trip.actions,
    verdict: passed ? "pearl returned alive" : gained === 0 && state.targetDeaths > 0 && state.pearlDrops.size === 0
      ? "no native pearl observed; expedition incomplete" : "expedition incomplete",
  });
  return { status: passed ? "succeeded" as const : "failed" as const, detail };
}

/** Native combat, loot and the return journey are owned by ordinary production actions. */
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, log } = context;
  const died = new AbortController();
  const params = paramsSchema.parse(context.scenario.params);
  const start = declaredStart(context);
  const home = start.floored();
  const endermen = declaredEntities(context).filter(({ name }) => name === "enderman");
  await prepareExpedition(context, params, home, endermen);
  const wave = createNativeWave(bot, endermen.map(({ position }) => position), log, (command) => bot.chat(command), context.signal);
  const signal = AbortSignal.any([context.signal, died.signal, wave.signal]);
  const observation = observeExpedition(context, start, wave, died, !!params.collection);
  try {
    const runtime = await openRuntime(context, "seeded-nether-enderman");
    const captureHit = (packet: unknown) => captureExpeditionHit(packet, bot, observation.state, runtime, log);
    bot._client.on("damage_event", captureHit);
    try {
      const trip = await travelExpedition({ context, params, home, wave, state: observation.state, runtime, signal });
      return expeditionResult(context, params, start, home, observation.state, trip);
    } finally {
      observation.state.collecting = false;
      bot._client.off("damage_event", captureHit);
      await runtime.close();
    }
  } finally {
    wave.close();
    observation.close();
    if (wave.error) throw wave.error;
  }
};
