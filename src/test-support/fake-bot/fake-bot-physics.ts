/**
 * The fake bot's client ticks as Mineflayer's physics plugin runs them (`physics.js`): when a tick fires, when it
 * does not (unloaded feet, a mount, a death), the look that waits for a tick, and `waitForTicks`. Nothing moves the
 * body unless the bot is made with `simulatePhysics`: then each tick runs Mineflayer's own engine (`prismarine-physics`)
 * on the fake world before `physicsTick`, as `physics.js` does; otherwise a test sets the position it needs.
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";
import type { FakeClock } from "./fake-clock.js";

/** Mineflayer's physics engine (no typings shipped): one step of a player's state, written back onto the bot. */
interface PrismarinePhysics {
  Physics(registry: unknown, world: unknown): { simulatePlayer(state: object, world: unknown): { apply(bot: object): void } };
  PlayerState: new (bot: object, controls: object) => object;
}

/** One step of `physics.js` `tickPhysics`: the player's state simulated with its controls and written back. */
function physicsStep(bot: FakeBot): () => void {
  const { Physics, PlayerState } = createRequire(import.meta.url)("prismarine-physics") as PrismarinePhysics;
  const engine = Physics(bot.registry, bot.world);
  // The fields `PlayerState` reads that Mineflayer's physics plugin keeps on the bot (`physics.js:40-45`).
  Object.assign(bot, { jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0 });
  return () => engine.simulatePlayer(new PlayerState(bot, bot.controlState), bot.world).apply(bot);
}

/** Mineflayer's `PHYSICS_TIMESTEP`: one client tick each 50 ms. */
const TICK_MS = 50;
/** How far the sent yaw turns in a tick: `PHYSICS_TIMESTEP * physics.yawSpeed` (prismarine-physics 3 rad/s, `physics.js:169`). */
const YAW_STEP_PER_TICK = 0.05 * 3;
/** Mineflayer ends a look once the sent yaw is this close to the body's (`physics.js:308-311`). */
const LOOK_DONE_YAW = 0.001;

/** `physics.js` `deltaYaw`: the signed turn from `from` to `to`, in -π..π. */
function deltaYaw(to: number, from: number): number {
  const turn = (to - from) % (2 * Math.PI);
  return turn < -Math.PI ? turn + 2 * Math.PI : turn > Math.PI ? turn - 2 * Math.PI : turn;
}

/** Mineflayer's standing eye height (`entities.js` `PLAYER_EYEHEIGHT`), which its typings leave off the entity. */
const PLAYER_EYE_HEIGHT = 1.62;

/** The eye's height above the feet: Mineflayer keeps it on the entity (lower while crouching). */
export function eyeHeightOf(entity: Bot["entity"]): number {
  return (entity as { eyeHeight?: number }).eyeHeight ?? PLAYER_EYE_HEIGHT;
}

/** A position this soon after a death is the respawn's, answered late (`physics.js` `respawnTimer`). */
const RESPAWN_WINDOW_MS = 2_000;
const RESPAWN_POSITION_DELAY_MS = 1_500;

/** `setControlState` as `physics.js:245-275` has it: sprint and sneak tell the server, on a change only. */
function attachFakeControls(bot: FakeBot): void {
  const controls = bot.controlState;
  bot.setControlState = (control, state) => {
    if (controls[control] === state) return;
    controls[control] = state;
    if (control === "sprint") {
      const actionId = bot.supportFeature("entityActionUsesStringMapper") ? (state ? "start_sprinting" : "stop_sprinting") : state ? 3 : 4;
      bot._client.write("entity_action", { entityId: bot.entity.id, actionId, jumpBoost: 0 });
    } else if (control === "sneak" && bot.supportFeature("newPlayerInputPacket")) {
      bot._client.write("player_input", { inputs: { shift: state } });
    } else if (control === "sneak") {
      bot._client.write("entity_action", { entityId: bot.entity.id, actionId: state ? 0 : 1, jumpBoost: 0 });
    }
  };
  bot.getControlState = (control) => controls[control] ?? false;
  bot.clearControlStates = () => {
    for (const control of Object.keys(controls) as (keyof typeof controls)[]) bot.setControlState(control, false);
  };
}

/** Mineflayer's own bound on `waitForTicks`: 50 ms a tick plus 5 s for lag (`physics.js:456-475`). */
function waitForTicksTimeoutMs(ticks: number): number {
  return ticks * TICK_MS + 5_000;
}

/** The fields of Mineflayer's `position` packet the fake reads. */
interface PositionPacket {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly teleportId: number;
}

/** Give `bot` its ticks, `look`, `lookAt` and `waitForTicks`, driven by `clock` and the `position` packets on its client. */
export function attachFakePhysics(bot: FakeBot, clock: FakeClock, simulate = false): void {
  // `shouldUsePhysics` of `physics.js`: off from a mount, a death or a respawn until the next position packet.
  let shouldUsePhysics = true;
  let accumulatedMs = 0;
  let pendingLook: (() => void) | null = null;
  /** `lastSentYaw`: the yaw the server was told, which turns toward the body's a step a tick. */
  let sentYaw = bot.entity.yaw;
  bot.physicsEnabled = true;
  const step = simulate ? physicsStep(bot) : null;

  const tickPhysics = () => {
    if (bot.blockAt(bot.entity.position) == null) return; // `physics.js:82`: the feet's chunk is not loaded
    if (bot.physicsEnabled && shouldUsePhysics) {
      step?.();
      bot.emit("physicsTick");
    }
    if (!shouldUsePhysics) return;
    // `updatePosition`: the sent yaw turns a step toward the body's; the look ends on the `move` once it caught up.
    sentYaw += Math.max(-YAW_STEP_PER_TICK, Math.min(YAW_STEP_PER_TICK, deltaYaw(bot.entity.yaw, sentYaw)));
    if (pendingLook === null || Math.abs(deltaYaw(bot.entity.yaw, sentYaw)) >= LOOK_DONE_YAW) return;
    const finished = pendingLook;
    pendingLook = null;
    bot.emit("move", bot.entity.position.clone());
    finished();
  };
  clock.onSlice("physics", (sliceMs) => {
    for (accumulatedMs += sliceMs; accumulatedMs >= TICK_MS; accumulatedMs -= TICK_MS) tickPhysics();
  });

  // Mineflayer's `respawnTimer`: a position within 2 s of a death restarts physics only 1500 ms later (`physics.js:429`).
  let diedAtMs: number | null = null;
  for (const event of ["mount", "respawn"] as const) bot.on(event, () => void (shouldUsePhysics = false));
  bot.on("death", () => {
    shouldUsePhysics = false;
    diedAtMs = clock.now();
  });
  const usePhysicsAgain = () => {
    shouldUsePhysics = true;
    bot.emit("forcedMove");
  };
  // Mineflayer's handler reads the packet on `_client` (`physics.js:380-450`): the server's `sendPosition` and a
  // client-fed one (`resumePhysics`, `vehicle-sync.ts`) both come this way (contract boat-get-off-by-shift).
  bot._client.on("position", (packet: PositionPacket) => {
    bot.entity.position.set(packet.x, packet.y, packet.z); // in place, as `pos.set` does: holders see the move
    bot.entity.onGround = false;
    bot._client.write("teleport_confirm", { teleportId: packet.teleportId });
    const sinceDeathMs = diedAtMs === null ? null : clock.now() - diedAtMs;
    diedAtMs = null;
    if (sinceDeathMs !== null && sinceDeathMs < RESPAWN_WINDOW_MS) clock.after(RESPAWN_POSITION_DELAY_MS, usePhysicsAgain);
    else usePhysicsAgain();
  });
  attachFakeControls(bot);

  bot.look = async (yaw, pitch, force) => {
    pendingLook?.();
    pendingLook = null;
    if (yaw === bot.entity.yaw && pitch === bot.entity.pitch) return;
    bot.entity.yaw = yaw;
    bot.entity.pitch = pitch;
    if (force) {
      sentYaw = yaw; // `lastSentYaw = yaw`: a forced look reaches the server at once
      return;
    }
    await new Promise<void>((resolve) => (pendingLook = resolve));
  };
  bot.lookAt = async (point, force) => {
    const delta = point.minus(bot.entity.position.offset(0, eyeHeightOf(bot.entity), 0));
    const yaw = Math.atan2(-delta.x, -delta.z);
    const pitch = Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z));
    await bot.look(yaw, pitch, force);
  };
  bot.waitForTicks = (ticks) => waitForPhysicsTicks(bot, clock, ticks);
}

/** `waitForTicks` as Mineflayer has it: physics ticks counted, rejected after its own bound with what is left. */
function waitForPhysicsTicks(bot: FakeBot, clock: FakeClock, ticks: number): Promise<void> {
  if (ticks <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let left = ticks;
    const onTick = () => {
      left -= 1;
      if (left > 0) return;
      cancelTimeout();
      bot.removeListener("physicsTick", onTick);
      resolve();
    };
    const cancelTimeout = clock.after(waitForTicksTimeoutMs(ticks), () => {
      bot.removeListener("physicsTick", onTick);
      reject(new Error(`Timeout waiting for ${left} ticks after ${waitForTicksTimeoutMs(left)}ms`));
    });
    bot.on("physicsTick", onTick);
  });
}
