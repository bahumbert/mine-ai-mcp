import type { Bot } from "mineflayer";
import { EventEmitter } from "node:events";
import { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner, type ActionRunnerOptions } from "../session/action-runner.js";
import { ReflexDriver, type ReflexDriverOptions } from "../survival/control/driver.js";
import { type FakeHarness, createFakeBot } from "./fake-bot/index.js";

export interface WaterFixtureOptions {
  /**
   * Build the bot on the shared fake (`fake-bot/`, returned as `harness`), whose player metadata is the version's
   * (`air_supply` at index 1). Off: a bare bot whose one metadata key puts `air_supply` at index 0, which the
   * builder's legacy-default test writes directly (`entity.metadata[0]`), until T3b-F deletes it.
   */
  readonly onHarness?: boolean;
}

/** Kept for the test of the builder's own legacy default (domain-builders.test.ts), until T3b-F deletes it: the old bare bot, an entity, a one-key player metadata and the control setter. */
function bareBot(setControlState: Bot["setControlState"]) {
  const entity = { isInWater: false, position: new Vec3(0, 64, 0), yaw: 0, onGround: true, metadata: [] };
  const bot = Object.assign(new EventEmitter(), {
    entity,
    registry: { entitiesByName: { player: { metadataKeys: ["air_supply"] } } },
    setControlState,
  }) as unknown as Bot;
  return { bot, entity, harness: undefined };
}

/** The shared fake's bot standing at (0, 64, 0). */
function harnessBot(setControlState: Bot["setControlState"]) {
  const harness: FakeHarness = createFakeBot({ position: new Vec3(0, 64, 0) });
  // Recorded, then the fake's own setter (`physics.js`: the control, and sprint or sneak sent on a change).
  const own = harness.bot.setControlState.bind(harness.bot);
  harness.bot.setControlState = (control, state) => {
    setControlState(control, state);
    own(control, state);
  };
  const entity = Object.assign(harness.bot.entity, { yaw: 0, isInWater: false, onGround: true });
  return { bot: harness.bot, entity, harness };
}

function oxygenFromAirSupply(bot: Bot): void {
  const airSupply = (bot.registry.entitiesByName.player as { metadataKeys?: string[] }).metadataKeys?.indexOf("air_supply") ?? -1;
  if (airSupply < 0) throw new Error("no air_supply metadata for a player");
  Object.defineProperty(bot, "oxygenLevel", {
    get: () => Number(bot.entity.metadata[airSupply]) / 15,
    set: (value: number) => {
      Reflect.set(bot.entity.metadata, airSupply, value * 15);
    },
    configurable: true,
  });
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
  const { bot, entity, harness } = options.onHarness ? harnessBot(record) : bareBot(record);
  const reflex = new ReflexDriver(bot, new ActionRunner(runnerOptions), driverOptions);
  t.after(() => reflex[Symbol.asyncDispose]());
  if (!harness) oxygenFromAirSupply(bot);

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
