/**
 * Getting off a boat: shift held until the server answers, then physics back on.
 *
 * A vanilla 1.21.4 server lets a passenger off on the shift it reads from `entity_action` (never from `player_input`,
 * which it reads for minecart steering only: backlog 76, Cleo, run 16) and tells her nothing: no position, and its
 * passenger list goes only to the other players. Every get-off that seemed to work before was the boat being broken
 * after it, which ejects its rider.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { writeShiftKey } from "../../navigation/mineflayer/sneak.js";
import { waitForWorldAge } from "../../world/world-age.js";
import { currentVehicle, forgetVehicle, letsHerOff, resumePhysics } from "./vehicle-sync.js";

/** Longest a get-off holds shift on the wall clock (a server far behind answers in seconds; a stopped one never does). */
const DISMOUNT_WALL_MS = 15_000;
/** Server ticks that pass after the shift before the server is taken to have handled it. */
const DISMOUNT_SERVER_TICKS = 40;
/**
 * How long after the press the client's queued packets are read before the world age is looked at. A client whose event
 * loop was blocked reads the time packets queued before the press only afterwards: the age then jumps by seconds that
 * say nothing of the server reading the shift (run 16: a server ~30 % behind "answered" the get-off in ~1.1 s).
 */
const SHIFT_DRAIN_MS = 250;

/** How a get-off ended: the server's answer, the world age moving on, the wall clock, or her death. */
export type GetOffEnd = "answer" | "world_age" | "timeout" | "died";

export interface GetOffResult {
  readonly vehicle: Entity | null;
  /** True unless only the wall clock ended the wait: the server may still have her seated. */
  readonly answered: boolean;
  readonly ended: GetOffEnd;
}

/**
 * Off the vehicle she rides, physics on again; returns it, and whether a server answered. Shift is held for the whole
 * wait (a server behind by seconds, run 14b: 3 to 8 s, can read a short press and its release in one tick and keep her
 * riding), or until another server answers (her boat's passenger list without her, the boat gone, a position); the
 * 40 server ticks that end it are counted from the world age seen {@link SHIFT_DRAIN_MS} after the press. Then the vehicle
 * is forgotten and physics resumed, unless a position did it (run 14b: eight bots froze after a get-off without this).
 */
export async function getOff(bot: Bot, options: { readonly wallMs?: number } = {}): Promise<GetOffResult> {
  const vehicle = currentVehicle(bot);
  const wallMs = options.wallMs ?? DISMOUNT_WALL_MS;
  let repositioned = false;
  let answered = false;
  let died = false;
  const done = () => {
    answered = true;
  };
  const onPosition = () => {
    repositioned = true;
    done();
  };
  const onPassengers = (packet: { readonly entityId: number; readonly passengers: readonly number[] }) => {
    if (letsHerOff(bot, vehicle, packet)) done();
  };
  const onGone = (entity: Entity) => {
    if (vehicle !== null && entity.id === vehicle.id) done();
  };
  const onDeath = () => {
    died = true;
  };
  bot.once("dismount", done);
  bot.once("forcedMove", onPosition);
  bot.on("entityGone", onGone);
  bot.once("death", onDeath);
  bot.once("respawn", onDeath);
  bot._client.on("set_passengers", onPassengers);
  let waited: Awaited<ReturnType<typeof waitForWorldAge>>;
  try {
    const pressedAt = performance.now();
    writeShiftKey(bot, true);
    const over = () => answered || died || currentVehicle(bot) === null;
    const drained = await waitForWorldAge(bot, Number.POSITIVE_INFINITY, { wallMs: Math.min(SHIFT_DRAIN_MS, wallMs), until: over });
    waited = drained === "until" ? drained : await waitForWorldAge(bot, DISMOUNT_SERVER_TICKS, { wallMs: wallMs - (performance.now() - pressedAt), until: over });
  } finally {
    bot.off("dismount", done);
    bot.off("forcedMove", onPosition);
    bot.off("entityGone", onGone);
    bot.off("death", onDeath);
    bot.off("respawn", onDeath);
    bot._client.off("set_passengers", onPassengers);
    writeShiftKey(bot, false);
  }
  // A death or respawn ends it here: the respawn brings its own position and physics.
  if (died) return { vehicle, answered: false, ended: "died" };
  // Already forgotten when the runtime's vehicle watch saw the answer first: it resumed physics too.
  if (forgetVehicle(bot) !== null && !repositioned) resumePhysics(bot);
  // The world age moved past the shift (or an answer came): the server handled it. Only the wall clock leaves it unknown.
  const ended: GetOffEnd = waited === "until" ? "answer" : waited === "moved" ? "world_age" : "timeout";
  return { vehicle, answered: ended !== "timeout", ended };
}

/**
 * Gets off the boat she rides (the next movement after a ride that stayed at sea starts here), as {@link getOff} does.
 */
export async function leaveBoat(bot: Bot): Promise<GetOffResult> {
  return getOff(bot);
}
