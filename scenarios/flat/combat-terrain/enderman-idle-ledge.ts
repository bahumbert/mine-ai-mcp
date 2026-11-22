// Native ledge threats are witnessed by packet identity while fixture phases count server age.
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";
import { readEncounters, type Encounter } from "../combat/reflex.ts";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { familyIndexOf } from "../../../src/world/item-families.ts";
import { z } from "zod";
import { Vec3 } from "vec3";

const paramsSchema = z.strictObject({
  mob: z.enum(["enderman", "skeleton", "magma_cube"]).default("enderman"),
  arrival: z.tuple([z.number(), z.number(), z.number()]).default([-130.5, 47, 197.61474899858322]),
  observeWithinTicks: z.number().int().positive().default(400),
  stimulusWithinTicks: z.number().int().positive().default(200),
  requireNativeArrow: z.boolean().default(false),
}).refine(params => !params.requireNativeArrow || params.mob === "skeleton", {
  message: "A native-arrow witness requires a skeleton.",
});
type Params = z.output<typeof paramsSchema>;
type Context = Pick<MineAiScenarioContext, "bot" | "signal" | "log"> & {
  scenario: Pick<MineAiScenarioContext["scenario"], "params">;
};
interface LedgeRuntime {
  status(): { owner: string; activeAction: { action: string } | null };
  close(): Promise<void>;
  captureIncident(): Promise<unknown>;
  readEncounters(): Promise<readonly Encounter[]>;
}
interface Dependencies {
  openRuntime(): Promise<LedgeRuntime>;
  standStill(): Promise<boolean>;
}
interface ArrowSpawn {
  readonly entityId: number;
  readonly type: number;
  readonly objectData: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
}

/** A scripted teleport delivers the threat; the server owns every shot, hit and knockback. */
export const run: MineAiScenario = context => runLedgeWith(context, {
  standStill: () => standStill(context),
  async openRuntime() {
    const runtime = await openRuntime(context, "enderman-ledge");
    return { status: () => runtime.status(), close: () => runtime.close(),
      captureIncident: () => runtime.captureIncident(), readEncounters: () => readEncounters(context, runtime) };
  },
});

/** Compose the real fixture phases with injectable storage/runtime startup for clock tests. */
export async function runLedgeWith(context: Context, deps: Dependencies) {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  context.signal.throwIfAborted();
  if (!(await deps.standStill())) throw new Error("The shelf spawn did not settle.");
  let runtime: LedgeRuntime | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal.reason);
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  const witness = observeNativeArrows(context, params);
  const observer = observeLedge(context, () => runtime?.status(), params.mob, controller);
  const phase = (name: string) => context.log(`LEDGE_PHASE ${JSON.stringify({ phase: name, age: context.bot.time.age })}`);
  try {
    if (!params.requireNativeArrow) runtime = await deps.openRuntime();
    else context.bot.clearControlStates();
    await releaseThreat(context, params, controller.signal, phase, witness.released);
    if (params.requireNativeArrow) {
      phase("stimulus");
      await waitPhase(context, params.stimulusWithinTicks, controller.signal, witness.exercised);
      if (!witness.exercised()) throw new Error("stimulus not delivered: no arrow from the released skeleton");
      controller.signal.throwIfAborted();
      phase("run-start");
      runtime = await deps.openRuntime();
    }
    controller.signal.throwIfAborted();
    phase("observation");
    await waitPhase(context, params.observeWithinTicks, controller.signal);
    controller.signal.throwIfAborted();
    const encounters = await runtime!.readEncounters();
    controller.signal.throwIfAborted();
    await runtime!.captureIncident();
    controller.signal.throwIfAborted();
    phase("complete");
    return observer.result(encounters, params.requireNativeArrow ? witness.exercised() : undefined);
  } catch (error) {
    return { status: "failed" as const, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    observer.close();
    witness.close();
    context.signal.removeEventListener("abort", abort);
    await runtime?.close();
  }
}

/** Attribute native arrow-family spawns to the single released skeleton, retaining vanished arrows in the log. */
function observeNativeArrows({ bot, log }: Context, params: Params) {
  let releasedSkeleton: number | undefined;
  let releasedAge: number | null | undefined;
  let bridgeStart: Vec3 | undefined;
  let witnessed = false;
  const spawn = (packet: ArrowSpawn) => {
    const name = bot.registry.entities[packet.type]?.name;
    if (!name || !familyIndexOf(bot).entityFamilies(name).includes("arrow_entity")) return;
    const age = bot.time.age;
    const towardBridge = bridgeStart !== undefined &&
      packet.velocity.x * (bridgeStart.x - packet.x) + packet.velocity.z * (bridgeStart.z - packet.z) > 0;
    const eligible = releasedSkeleton !== undefined && releasedAge != null && age != null && towardBridge &&
      packet.objectData === releasedSkeleton && age >= releasedAge && age - releasedAge <= params.stimulusWithinTicks;
    witnessed ||= eligible;
    log(`ARROW_SPAWN ${JSON.stringify({ age, releasedAge, releasedSkeleton, towardBridge, eligible, packet })}`);
  };
  const hurt = (packet: { entityId: number; sourceDirectId: number; sourceCauseId: number }) => {
    log(`ARROW_DAMAGE ${JSON.stringify({ age: bot.time.age, victim: packet.entityId,
      direct: packet.sourceDirectId - 1, shooter: packet.sourceCauseId - 1, packet })}`);
  };
  bot._client.on("spawn_entity", spawn);
  bot._client.on("damage_event", hurt);
  return {
    released() {
      const skeletons = Object.values(bot.entities).filter(entity => entity.name === "skeleton" && entity.isValid);
      if (params.requireNativeArrow && skeletons.length !== 1)
        throw new Error(`Native arrow observation requires exactly one released skeleton; observed ${skeletons.length}.`);
      if (skeletons.length === 1) releasedSkeleton = skeletons[0]!.id;
      releasedAge = bot.time.age;
      bridgeStart = bot.entity.position.clone();
    },
    exercised: () => witnessed,
    close() { bot._client.off("spawn_entity", spawn); bot._client.off("damage_event", hurt); },
  };
}

/** A stopped age fails the fixture even when client physics continues. */
async function waitPhase(context: Context, ticks: number, signal: AbortSignal, until?: () => boolean) {
  const outcome = await waitServerTicks(context.bot, ticks, { signal, ...(until ? { until } : {}) });
  signal.throwIfAborted();
  if (outcome === "stalled" || outcome === "timeout") throw new Error(`The ledge world age stopped (${outcome}).`);
  return outcome;
}

/** Stage and settle before release; never intervene in native combat after the release command. */
async function releaseThreat(context: Context, params: Params, signal: AbortSignal,
  phase: (name: string) => void, released: () => void) {
  const { bot, log } = context;
  const { mob, arrival } = params;
  const send = (command: string) => { signal.throwIfAborted(); bot.chat(command); signal.throwIfAborted(); };
  phase("staging");
  const equipment = mob === "skeleton" ? ',HandItems:[{id:"minecraft:bow",count:1},{}]' : "";
  send(`/summon ${mob} -128.5 57 240.5 {NoAI:1b,Size:3,PersistenceRequired:1b,Tags:["ledge_arrival"]${equipment}}`);
  const staged = () => Object.values(bot.entities).some(entity => entity.name === mob && entity.isValid);
  await waitPhase(context, 40, signal, staged);
  if (!staged()) throw new Error(`The staged ${mob} was not observed.`);
  phase("settle");
  await waitPhase(context, 20, signal);
  if (!atEdge(context) || bot.entity.position.distanceTo(new Vec3(-128.53437787507164, 47, 197.61474899858322)) > 0.05)
    throw new Error("The bot left the starting edge before the contact stimulus.");
  const uuid = Buffer.from(bot.players[bot.username]!.uuid.replaceAll("-", ""), "hex");
  const angryAt = [0, 4, 8, 12].map(offset => uuid.readInt32BE(offset)).join(",");
  log(`TELEPORT_CONTACT ${JSON.stringify({ age: bot.time.age, position: bot.entity.position })}`);
  send(`/data merge entity @e[tag=ledge_arrival,limit=1] {AngerTime:600,AngryAt:[I;${angryAt}]}`);
  send(`/tp @e[tag=ledge_arrival,limit=1] ${arrival.join(" ")}`);
  released();
  phase("release");
  send(`/data merge entity @e[tag=ledge_arrival,limit=1] {NoAI:0b}`);
}

/** Grounded contact beside lava remains telemetry and the sibling melee scenarios' criterion. */
function atEdge({ bot }: Context) {
  if (!bot.entity.onGround || bot.entity.position.y !== 47) return false;
  const feet = bot.entity.position.floored();
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
    const x = feet.x + dx!;
    const z = feet.z + dz!;
    return bot.blockAt(new Vec3(x, 46, z))?.name === "air" && bot.blockAt(new Vec3(x, 31, z))?.name === "lava";
  });
}

/** Keep physical telemetry and survival constraints independent of the required contact evidence. */
function observeLedge(context: Context, runtimeStatus: () => ReturnType<LedgeRuntime["status"]> | undefined,
  mob: Params["mob"], controller: AbortController) {
  const { bot, log } = context;
  const state = { ticks: 0, hits: 0, shieldBlocks: 0, landedAttacks: 0, edgeContacts: 0,
    deaths: 0, lava: false, minimumY: bot.entity.position.y };
  const placedBlocks: { x: number; y: number; z: number }[] = [];
  const scaffolds = () => bot.inventory.items().filter(item => item.name === "cobblestone")
    .reduce((sum, item) => sum + item.count, 0);
  const scaffoldsBefore = scaffolds();
  const frame = () => ({
    tick: state.ticks, age: bot.time.age, position: bot.entity.position.clone(), velocity: bot.entity.velocity.clone(),
    onGround: bot.entity.onGround, health: bot.health, offHand: bot.inventory.slots[45]?.name ?? null,
    owner: runtimeStatus()?.owner ?? "fixture", action: runtimeStatus()?.activeAction?.action ?? null,
    controls: Object.fromEntries((["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const)
      .map(control => [control, bot.getControlState(control)])),
  });
  let dyingPosition: ReturnType<typeof frame> | null = null;
  const hurt = (packet: { entityId: number; sourceCauseId: number }) => {
    if (packet.sourceCauseId === bot.entity.id + 1 && bot.entities[packet.entityId]?.name === mob) state.landedAttacks++;
    if (packet.entityId !== bot.entity.id || bot.entities[packet.sourceCauseId - 1]?.name !== mob) return;
    state.hits++;
    if (atEdge(context)) state.edgeContacts++;
    log(`NATIVE_HIT ${JSON.stringify({ ...frame(), atEdge: atEdge(context) })}`);
  };
  const status = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId !== bot.entity.id || packet.entityStatus !== 29) return;
    state.shieldBlocks++;
    if (atEdge(context)) state.edgeContacts++;
    log(`NATIVE_SHIELD_BLOCK ${JSON.stringify({ ...frame(), atEdge: atEdge(context) })}`);
  };
  const death = () => { dyingPosition = frame(); state.deaths++; controller.abort(new Error("The ledge bot died.")); };
  const tick = () => {
    state.ticks++;
    state.minimumY = Math.min(state.minimumY, bot.entity.position.y);
    state.lava ||= Reflect.get(bot.entity, "isInLava") === true;
    log(`LEDGE_TICK ${JSON.stringify(frame())}`);
  };
  const blockUpdate: import("mineflayer").BotEvents["blockUpdate"] = (before, after) => {
    if (before?.name !== "cobblestone" && after?.name === "cobblestone") {
      placedBlocks.push({ ...after.position });
      log(`SCAFFOLD_OBSERVED ${JSON.stringify(after.position)}`);
    }
  };
  bot._client.on("damage_event", hurt);
  bot._client.on("entity_status", status);
  bot.on("death", death);
  bot.on("physicsTick", tick);
  bot.on("blockUpdate", blockUpdate);
  return {
    close() {
      bot._client.off("damage_event", hurt); bot._client.off("entity_status", status);
      bot.off("death", death); bot.off("physicsTick", tick); bot.off("blockUpdate", blockUpdate);
    },
    result(encounters: readonly Encounter[], nativeArrow?: boolean) {
      return {
        status: (nativeArrow ?? state.edgeContacts > 0) && state.deaths === 0 && !state.lava && state.minimumY >= 47 && bot.entity.onGround
          ? "succeeded" as const : "failed" as const,
        detail: JSON.stringify({ ...state, nativeArrow, placedBlocks, scaffoldsBefore, scaffoldsAfter: scaffolds(),
          encounters, dyingPosition, final: frame() }),
      };
    },
  };
}
