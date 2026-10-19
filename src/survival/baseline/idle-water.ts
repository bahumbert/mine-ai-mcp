import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../navigation/index.js";
import { horizontalControlsToward } from "../../navigation/index.js";
import type { ActionRunner } from "../../session/action-runner.js";
import type { Position3 } from "../../utils/index.js";
import { botEyesInWater } from "../../world/eyes-in-water.js";
import { isInWater } from "../perception/body.js";

/**
 * Keeps a bot afloat in water, in two modes that hand over to each other without a tick where jump drops.
 *
 * Idle (no action owns the body): a baseline body owner, released by admission before the new owner writes controls.
 * Working (a foreground action owns it): while nothing steers the body (no route, process or dive, no held water
 * stance, no reflex) and the eyes are under water the way the server decides it, press jump so the bot floats up and
 * breathes (run 15: a smelt standing in water two blocks deep sank until [BREATH] cancelled it, again and again).
 * A worker in shallow water with its eyes out is left alone.
 */
export function attachIdleWaterControl(
  bot: Bot,
  navigation: Pick<NavigationRuntime, "active" | "steering">,
  runner: ActionRunner,
): Disposable {
  let anchor: Position3 | null = null;
  let ownsControls = false;
  const release = () => {
    anchor = null;
    if (!ownsControls) return;
    ownsControls = false;
    for (const control of ["jump", "forward", "back", "left", "right"] as const) bot.setControlState(control, false);
  };
  /** Horizontal place held against currents from the anchor (taken where the mode starts), and jump as asked. */
  const holdPlace = (jump: boolean) => {
    ownsControls = true;
    anchor ??= { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
    const correction = horizontalControlsToward(bot.entity, anchor, 0.05);
    for (const control of ["forward", "back", "left", "right"] as const)
      bot.setControlState(control, correction[control]);
    bot.setControlState("jump", jump);
  };
  const working = () => {
    if (navigation.steering) {
      // Whoever steers writes the controls; ours are cleared once nothing does.
      anchor = null;
      return;
    }
    if (botEyesInWater(bot)) holdPlace(true);
    else release();
  };
  const idle = () => {
    if (!isInWater(bot) && bot.entity.onGround) {
      runner.releaseBaseline("idle_water");
      release();
      return;
    }
    if (!isInWater(bot) && anchor === null) return;
    if (!runner.holdBaseline("idle_water", release)) return;
    holdPlace(isInWater(bot));
  };
  const tick = () => {
    const { owner } = runner.status();
    if (owner === "foreground") return working();
    if (owner === "idle" && !navigation.active) return idle();
    // Another owner (a route, a reflex): it writes the controls. What the working mode set is cleared once the body
    // is ours or nobody's again; an idle hold on a primitive used directly outside action admission is just let go.
    if (owner === "idle") ownsControls = false;
    runner.releaseBaseline("idle_water");
    anchor = null;
  };
  bot.on("physicsTick", tick);
  return {
    [Symbol.dispose]() {
      bot.off("physicsTick", tick);
      runner.releaseBaseline("idle_water");
      release();
    },
  };
}
