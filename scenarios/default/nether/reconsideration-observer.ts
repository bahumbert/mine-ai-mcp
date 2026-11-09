/** Observe native target hits and server-confirmed arranged movement. */
import { Vec3 } from "vec3";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import type { Runtime } from "../../src/runtime.ts";

export function observeReconsideration(context: MineAiScenarioContext, runtime: Runtime, ids: { primary: number; alternative: number }, params: { mode: string; teleportTo?: [number, number, number]; returnTo?: [number, number, number] }, child: AbortController) {
  const { bot, log } = context;
  let firstNativeHit: number | null = null;
  let primaryMoved = false;
  let primaryReturned = false;
  let deaths = 0;
  let move: { target: Vec3; returning: boolean; ticks: number; deadline: number; timer: ReturnType<typeof setTimeout> } | undefined;
  const { promise: failure, reject } = Promise.withResolvers<never>();
  const proof = () => {
    if (firstNativeHit !== null && (params.mode !== "failed_approach" || (primaryMoved && primaryReturned))) child.abort("scenario proof observed");
  };
  const sendMove = (target: [number, number, number], returning: boolean) => {
    const timer = setTimeout(() => reject(new Error("arranged move not observed")), 5_000);
    move = { target: new Vec3(...target), returning, ticks: 0, deadline: monotonicNow() + 5_000, timer };
    bot.chat(`/tp @e[tag=reconsider_primary,limit=1] ${target.join(" ")}`);
    log(`PRIMARY_MOVE_SENT ${JSON.stringify({ target, returning, at: monotonicNow() })}`);
    if (returning) bot.chat("/data merge entity @e[tag=reconsider_primary,limit=1] {NoGravity:0b}");
  };
  const moved = (entity: typeof bot.entity) => {
    if (!move || entity.id !== ids.primary || entity.position.distanceTo(move.target) > 1.5) return;
    if (monotonicNow() > move.deadline) { clearTimeout(move.timer); reject(new Error("arranged move not observed")); return; }
    clearTimeout(move.timer);
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
    if (firstNativeHit === null && (packet.sourceCauseId === bot.entity.id + 1 || packet.sourceDirectId === bot.entity.id + 1) && (packet.entityId === ids.primary || packet.entityId === ids.alternative)) {
      firstNativeHit = packet.entityId;
      log(`FIRST_NATIVE_TARGET_HIT ${packet.entityId}`);
      proof();
    }
  };
  const tick = () => {
    const checkpoint = runtime.status().survival.request?.evidence?.checkpoint;
    const selected = typeof checkpoint === "object" && checkpoint !== null && "selectedTargetId" in checkpoint ? checkpoint.selectedTargetId : null;
    if (move && ++move.ticks >= 100) { clearTimeout(move.timer); reject(new Error("arranged move not observed")); }
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
    snapshot: () => ({ firstNativeHit, primaryMoved, primaryReturned, deaths, movePending: move !== undefined }),
    close: () => {
      bot._client.off("damage_event", damage); bot._client.off("entity_teleport", teleport);
      bot.off("physicsTick", tick); bot.off("entityMoved", moved); bot.off("death", death);
      if (move) clearTimeout(move.timer);
    },
  };
}
