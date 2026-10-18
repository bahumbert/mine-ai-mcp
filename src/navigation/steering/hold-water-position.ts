import type { Position3 } from "../../utils/index.js";
import { holdSwimDepth } from "../world/swimming.js";
import { horizontalControlsToward, type HorizontalSteeringControl } from "./local-steering.js";

interface WaterPositionBot {
  readonly entity: { readonly position: Position3; readonly velocity?: Position3; readonly onGround?: boolean; readonly yaw?: number; readonly isInWater?: boolean };
  on(event: "physicsTick", listener: () => void): unknown;
  off(event: "physicsTick", listener: () => void): unknown;
  setControlState(control: HorizontalSteeringControl | "jump", active: boolean): void;
}

/** How many water stances each bot holds right now: the stance steers the body (it keeps its own depth), so nothing else may. */
const stancesHeld = new WeakMap<object, number>();

/** Water stances `bot` holds at this moment (see {@link holdWaterPosition}). */
export function waterStancesHeld(bot: object): number {
  return stancesHeld.get(bot) ?? 0;
}

/** Hold a stationary interaction against a current without changing its aim. It counts as held (see {@link waterStancesHeld}) until released or aborted. */
export function holdWaterPosition(
  bot: WaterPositionBot,
  signal: AbortSignal | undefined,
  setControl: (control: HorizontalSteeringControl | "jump", active: boolean) => void = (control, active) =>
    bot.setControlState(control, active),
): () => void {
  const standing = { ...bot.entity.position };
  const controls = ["forward", "back", "left", "right"] as const;
  const hold = () => {
    const correction = horizontalControlsToward(
      { position: bot.entity.position, yaw: bot.entity.yaw ?? 0 },
      standing,
      0.05,
    );
    for (const control of controls)
      setControl(control, !signal?.aborted && bot.entity.isInWater === true && correction[control]);
    // Supported mining must stay on its floor: jumping multiplies dig time again.
    if (bot.entity.isInWater) setControl("jump", !signal?.aborted && !bot.entity.onGround &&
      holdSwimDepth(bot.entity.position.y, bot.entity.velocity?.y ?? 0, standing.y));
  };
  let counted = signal?.aborted !== true;
  const leaveStance = () => {
    if (!counted) return;
    counted = false;
    stancesHeld.set(bot, waterStancesHeld(bot) - 1);
  };
  if (counted) stancesHeld.set(bot, waterStancesHeld(bot) + 1);
  signal?.addEventListener("abort", leaveStance, { once: true });
  bot.on("physicsTick", hold);
  return () => {
    signal?.removeEventListener("abort", leaveStance);
    leaveStance();
    bot.off("physicsTick", hold);
    for (const control of controls) setControl(control, false);
    setControl("jump", false);
  };
}
