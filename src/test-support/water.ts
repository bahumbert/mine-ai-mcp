import type { Bot } from "mineflayer";
import { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner, type ActionRunnerOptions } from "../session/action-runner.js";
import { ReflexDriver, type ReflexDriverOptions } from "../survival/control/driver.js";
import { type FakeClock, type FakeHarness, createFakeBot } from "./fake-bot/index.js";

export interface WaterFixtureOptions {
  /** The harness's clock, which the test drives and the driver and the runner read (their own `now` and `clock` options win); a new manual clock otherwise. */
  readonly clock?: FakeClock;
}

/** The shared fake's bot standing at (0, 64, 0), its controls recorded. */
function harnessBot(setControlState: Bot["setControlState"], clock: FakeClock | undefined) {
  const harness: FakeHarness = createFakeBot({ position: new Vec3(0, 64, 0), clock });
  // Recorded, then the fake's own setter (`physics.js`: the control, and sprint or sneak sent on a change).
  const own = harness.bot.setControlState.bind(harness.bot);
  harness.bot.setControlState = (control, state) => {
    setControlState(control, state);
    own(control, state);
  };
  const entity = Object.assign(harness.bot.entity, { yaw: 0, isInWater: false, onGround: true });
  return { bot: harness.bot, entity, harness };
}

/** A bot standing at (0, 64, 0) with a reflex driver, the controls it set in order, and a "moving" flag the test raises. */
export function waterFixture(
  t: TestContext,
  driverOptions: ReflexDriverOptions = {},
  runnerOptions: ActionRunnerOptions = {},
  options: WaterFixtureOptions = {},
) {
  let moving = false;
  const controls: Array<readonly [control: string, state: boolean]> = [];
  const record: Bot["setControlState"] = (control, state) => void controls.push([control, state]);
  const { bot, entity, harness } = harnessBot(record, options.clock);
  const reflex = new ReflexDriver(
    bot,
    new ActionRunner({ ...(options.clock && { clock: options.clock }), ...runnerOptions }),
    { ...(options.clock && { now: options.clock.now }), ...driverOptions },
  );
  t.after(() => reflex[Symbol.asyncDispose]());

  return {
    bot,
    reflex,
    entity,
    controls,
    harness,
    isMoving: () => moving,
    setMoving: (value: boolean) => {
      moving = value;
    },
  };
}
