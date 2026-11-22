/** Observe native target hits and server-confirmed arranged movement. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { serverPacedSignal, type ServerPacedSignal } from "../../../src/world/server-paced.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import type { Runtime } from "../../src/runtime.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../../tests/minecraft/drivers/server-ticks.ts";
import type { ProductiveProgress } from "../../../tests/minecraft/drivers/productive-progress.ts";

type Cell = readonly [number, number, number];
/** A server position in blocks, to one decimal. */
type Position = readonly [number, number, number];
/** Server ticks an arranged `/tp` has to be seen in (the old 100 client physics ticks, which are 50 server ticks at 10 tps). */
const ARRANGED_MOVE_TICKS = 100;
/**
 * What the YAML declares for a pursuit: the window after the first hit, the displacement that counts as moved and
 * followed, the prepared terrain box (inclusive cells) and an optional arranged provocation (a chat command sent at the
 * first hit and again every `everyTicks` server ticks): a melee fight never moves an Enderman, only damage with no
 * living source teleports it, so the fixture declares it.
 */
export interface PursuitParams { windowTicks: number; minDisplacement: number; terrain: { from: Cell; to: Cell }; provoke?: { everyTicks: number; command: string } }
export interface PursuitSnapshot {
  hits: number;
  /** Server ticks from the first hit to the last time packet (the end of the pursuit once it ended). */
  ticks: number;
  /** `window`: the window passed; `target died`: the server said the target died; null: still open (or closed by the driver). */
  ended: "window" | "target died" | null;
  /** The farthest the target stood from where it was at the first hit, in blocks. */
  targetDisplacement: number;
  botDisplacement: number;
  minimumY: number;
  /** Distinct cells the bot stood in outside the terrain box. */
  offTerrainCells: number;
  /** Whether the bot's last sampled cell is inside the terrain box. */
  onTerrain: boolean;
  /** The straight distance from the terrain box (blocks, 0 inside): the farthest the bot stood, and where it ended. */
  maxDistanceOffTerrain: number;
  endDistanceOffTerrain: number;
  /** Both positions at the first hit and at each time packet: the bot's path and the target's (null: not loaded). */
  samples: { age: number; target: Position | null; bot: Position }[];
}

const TICKS_PER_GAME_MINUTE = 1_200;

/** How the next action from a pursuit's end ended: `navigate` home, or a failure (its own, or its server-tick budget's). */
export type NextActionOutcome = "home" | "bounded failure";

const insideBox = (cell: Cell, box: PursuitParams["terrain"]) => cell.every((value, axis) => value >= box.from[axis]! && value <= box.to[axis]!);
const cellOf = (position: Vec3): Cell => [Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)];
/** Straight distance from a point to the box of cells, whose blocks span `from` up to `to + 1` on each axis (0 inside). */
function distanceToBox(position: Vec3, box: PursuitParams["terrain"]): number {
  const axes = [position.x, position.y, position.z];
  return Math.hypot(...axes.map((value, axis) => Math.max(box.from[axis]! - value, 0, value - (box.to[axis]! + 1))));
}
const placeOf = (position: Vec3): Position => [Math.round(position.x * 10) / 10, Math.round(position.y * 10) / 10, Math.round(position.z * 10) / 10];

/** Hits per game minute of the observed pursuit; null before any server tick passed. */
export function hitsPerGameMinute(pursuit: Pick<PursuitSnapshot, "hits" | "ticks">): number | null {
  return pursuit.ticks > 0 ? (pursuit.hits * TICKS_PER_GAME_MINUTE) / pursuit.ticks : null;
}

const oneDecimal = (value: number) => Math.round(value * 10) / 10;

/**
 * Problems of a pursuit trial (empty = pass), as spec D17 (owner 2026-11-18): the stimulus happened (the target moved at
 * least `minDisplacement` blocks and the bot followed that far), the pursuit ran to its end (the window passed or the
 * target died), the bot is alive, and the next action ended within its budget, home or in a bounded failure. The
 * distances off the terrain, the off-terrain cells and the home rate are measures: this judge takes none of them.
 */
export function judgePursuit(measure: { firstHit: boolean; ended: PursuitSnapshot["ended"]; targetDisplacement: number; botDisplacement: number; deaths: number; health: number; next: NextActionOutcome | null }, minDisplacement: number): string[] {
  const problems: string[] = [];
  if (measure.deaths > 0 || measure.health <= 0) problems.push("the bot died");
  if (!measure.firstHit) problems.push("no pursuit: the hunt ended before the first hit");
  else {
    if (measure.ended === null) problems.push("no pursuit: the hunt ended before the window passed or the target died");
    if (measure.targetDisplacement < minDisplacement) problems.push(`no pursuit: the target moved ${oneDecimal(measure.targetDisplacement)} blocks, less than ${minDisplacement}`);
    else if (measure.botDisplacement < minDisplacement) problems.push(`the bot did not follow: it moved ${oneDecimal(measure.botDisplacement)} blocks, less than ${minDisplacement}`);
  }
  if (measure.next === null) problems.push("the next action did not end within its budget");
  return problems;
}

/** Displacements from the positions at the first hit, the lowest y and the cells off the terrain of one pursuit. */
function pursuitMeasures(bot: Bot, targetId: number, terrain: PursuitParams["terrain"]) {
  let targetStart: Vec3 | null = null;
  let botStart = new Vec3(0, 0, 0);
  let targetDisplacement = 0;
  let botDisplacement = 0;
  let minimumY = Infinity;
  let onTerrain = true;
  let maxDistance = 0;
  let endDistance = 0;
  const offTerrain = new Set<string>();
  return {
    /** Take the positions the displacements count from. */
    begin() {
      targetStart = bot.entities[targetId]?.position.clone() ?? null;
      botStart = bot.entity.position.clone();
    },
    /** The target's server position now (null once it is not loaded); keeps its farthest displacement. */
    target(): Position | null {
      const position = bot.entities[targetId]?.position;
      if (position && targetStart) targetDisplacement = Math.max(targetDisplacement, position.distanceTo(targetStart));
      return position ? placeOf(position) : null;
    },
    place: (): Position => placeOf(bot.entity.position),
    /** Sample the bot: its farthest displacement, lowest y and terrain cells. */
    bot() {
      const position = bot.entity.position;
      botDisplacement = Math.max(botDisplacement, position.distanceTo(botStart));
      minimumY = Math.min(minimumY, position.y);
      const cell = cellOf(position);
      onTerrain = insideBox(cell, terrain);
      if (!onTerrain) offTerrain.add(cell.join(","));
      endDistance = distanceToBox(position, terrain);
      maxDistance = Math.max(maxDistance, endDistance);
    },
    read: () => ({ targetDisplacement, botDisplacement, minimumY, offTerrainCells: offTerrain.size, onTerrain, maxDistanceOffTerrain: maxDistance, endDistanceOffTerrain: endDistance }),
  };
}

/**
 * Measure a pursuit from the first native hit on `targetId` until its window of server ticks passes (the shared
 * `serverPacedSignal`: the window never ends before `windowTicks` server ticks, a stale last time packet allowed for,
 * and a stopped clock fails it through `reject`) or the server says the target died. The progress window stays open
 * meanwhile. `close` ends the tracking at once (a failure, the driver settling) and leaves `ended` null.
 */
function trackPursuit(context: MineAiScenarioContext, targetId: number, params: PursuitParams, child: AbortController, reject: (error: Error) => void, progress?: Pick<ProductiveProgress, "observing">) {
  const { bot } = context;
  const measures = pursuitMeasures(bot, targetId, params.terrain);
  let started = false;
  let open = false;
  let ended: PursuitSnapshot["ended"] = null;
  let startAge = 0;
  let lastAge = 0;
  let provokedAge = 0;
  let hits = 0;
  let budget: ServerPacedSignal | undefined;
  const samples: PursuitSnapshot["samples"] = [];

  /** Every teardown step runs even when the progress callback throws; its error still reaches the caller. */
  const finish = (reason: PursuitSnapshot["ended"], failure?: Error) => {
    if (!open) return;
    open = false;
    if (reason) { measures.target(); measures.bot(); }
    ended = reason;
    budget?.[Symbol.dispose]();
    bot.off("time", onTime);
    bot.off("physicsTick", measures.bot);
    bot.off("entityDead", onDead);
    try { progress?.observing(false); }
    finally {
      if (failure) reject(failure);
      else if (reason) child.abort(`pursuit ended: ${reason}`);
    }
  };
  const sample = (age: number) => { samples.push({ age, target: measures.target(), bot: measures.place() }); };
  const onTime = () => {
    const age = bot.time.age;
    if (age === lastAge) return;
    lastAge = age;
    sample(age);
    if (params.provoke && age - provokedAge >= params.provoke.everyTicks) provoke();
  };
  const provoke = () => {
    if (!params.provoke) return;
    provokedAge = bot.time.age;
    bot.chat(params.provoke.command);
    context.log(`PURSUIT_PROVOKED ${JSON.stringify({ age: provokedAge, command: params.provoke.command })}`);
  };
  /** Status 3 is the server's word that the target died; an unload (`entityGone`) is not: the target may stand on far away. */
  const onDead = (entity: { id: number }) => { if (entity.id === targetId) finish("target died"); };
  const onBudget = () => {
    if (budget?.end() === "ticks") return finish("window");
    finish(null, new Error(`server clock stopped during pursuit (${budget?.end() ?? "unknown"})`));
  };

  return {
    /** A native hit on the target: the first starts the window, later ones inside it count. */
    hit() {
      if (started && !open) return;
      hits++;
      if (started) return;
      started = open = true;
      startAge = lastAge = bot.time.age;
      measures.begin();
      measures.bot();
      sample(startAge);
      progress?.observing(true);
      budget = serverPacedSignal(bot, params.windowTicks, { stoppedMs: DRIVER_CLOCK_STOPPED_MS });
      budget.signal.addEventListener("abort", onBudget, { once: true });
      provoke();
      bot.on("time", onTime);
      bot.on("physicsTick", measures.bot);
      bot.on("entityDead", onDead);
    },
    snapshot(): PursuitSnapshot | null {
      if (!started) return null;
      return { hits, ticks: lastAge - startAge, ended, ...measures.read(), samples: [...samples] };
    },
    close: () => finish(null),
  };
}

export function observeReconsideration(context: MineAiScenarioContext, runtime: Runtime, ids: { primary: number; alternative?: number }, params: { mode: string; teleportTo?: [number, number, number]; returnTo?: [number, number, number]; pursuit?: PursuitParams }, child: AbortController, progress?: Pick<ProductiveProgress, "observing">) {
  const { bot, log } = context;
  let firstNativeHit: number | null = null;
  let primaryMoved = false;
  let primaryReturned = false;
  let deaths = 0;
  let move: { target: Vec3; returning: boolean; budget: ServerPacedSignal } | undefined;
  const { promise: failure, reject } = Promise.withResolvers<never>();
  if (params.mode === "pursuit" && !params.pursuit) throw new Error("pursuit mode needs its pursuit params");
  const pursuit = params.mode === "pursuit" ? trackPursuit(context, ids.primary, params.pursuit!, child, reject, progress) : undefined;
  const proof = () => {
    // A pursuit never ends at a hit: the hit starts its window, which ends the hunt.
    if (params.mode === "pursuit") return;
    if (firstNativeHit !== null && (params.mode !== "failed_approach" || (primaryMoved && primaryReturned))) child.abort("scenario proof observed");
  };
  const sendMove = (target: [number, number, number], returning: boolean) => {
    // Server ticks, with a stopped-clock bound: the old 100 client ticks and 5 wall seconds gave a slow server half the game time.
    const budget = serverPacedSignal(bot, ARRANGED_MOVE_TICKS, { stoppedMs: DRIVER_CLOCK_STOPPED_MS });
    budget.signal.addEventListener("abort", () => reject(new Error("arranged move not observed")), { once: true });
    move = { target: new Vec3(...target), returning, budget };
    bot.chat(`/tp @e[tag=reconsider_primary,limit=1] ${target.join(" ")}`);
    log(`PRIMARY_MOVE_SENT ${JSON.stringify({ target, returning, at: monotonicNow() })}`);
    if (returning) bot.chat("/data merge entity @e[tag=reconsider_primary,limit=1] {NoGravity:0b}");
  };
  const moved = (entity: typeof bot.entity) => {
    if (!move || entity.id !== ids.primary || entity.position.distanceTo(move.target) > 1.5) return;
    if (move.budget.signal.aborted) return; // its abort already rejected "arranged move not observed"
    move.budget[Symbol.dispose]();
    if (move.returning) primaryReturned = true; else primaryMoved = true;
    log(`PRIMARY_MOVE_OBSERVED ${JSON.stringify({ returning: move.returning, position: entity.position })}`);
    move = undefined;
    proof();
  };
  const teleport = (packet: { entityId: number }) => {
    if (packet.entityId === ids.primary) queueMicrotask(() => { const entity = bot.entities[ids.primary]; if (entity) moved(entity); });
  };
  const death = () => { deaths++; };
  const damage = (packet: { entityId: number; sourceCauseId: number; sourceDirectId: number }) => {
    const native = (packet.sourceCauseId === bot.entity.id + 1 || packet.sourceDirectId === bot.entity.id + 1) && (packet.entityId === ids.primary || packet.entityId === ids.alternative);
    if (native && firstNativeHit === null) {
      firstNativeHit = packet.entityId;
      log(`FIRST_NATIVE_TARGET_HIT ${packet.entityId}`);
      proof();
    }
    if (native && packet.entityId === ids.primary) pursuit?.hit();
  };
  const tick = () => {
    const checkpoint = runtime.status().survival.request?.evidence?.checkpoint;
    const selected = typeof checkpoint === "object" && checkpoint !== null && "selectedTargetId" in checkpoint ? checkpoint.selectedTargetId : null;
    if (!move && !primaryMoved && selected === ids.primary && params.teleportTo) sendMove(params.teleportTo, false);
    if (!move && primaryMoved && !primaryReturned && selected === ids.alternative && params.returnTo) sendMove(params.returnTo, true);
  };
  bot._client.on("damage_event", damage);
  bot._client.on("entity_teleport", teleport);
  bot.on("physicsTick", tick);
  bot.on("entityMoved", moved);
  bot.on("death", death);
  return {
    failure,
    snapshot: () => ({ firstNativeHit, primaryMoved, primaryReturned, deaths, movePending: move !== undefined, pursuit: pursuit?.snapshot() ?? null }),
    /** End the pursuit's tracking now, so a later cleanup (a `/kill`) cannot become its endpoint. */
    settlePursuit: () => pursuit?.close(),
    close: () => {
      try { pursuit?.close(); }
      finally {
        bot._client.off("damage_event", damage); bot._client.off("entity_teleport", teleport);
        bot.off("physicsTick", tick); bot.off("entityMoved", moved); bot.off("death", death);
        move?.budget[Symbol.dispose]();
      }
    },
  };
}
