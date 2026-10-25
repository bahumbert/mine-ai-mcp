/** The `ScenarioContext` a driver test hands to `run`: the real shape, with the host's controls stood in by plain state. */
import type { ScenarioDefinition } from "mine-labs/client";
import type { Bot } from "mineflayer";
import { createFakeBot } from "../../src/test-support/fake-bot/index.ts";
import { ZERO_ARENA, arenaFrame, type ArenaFrame } from "./arena/frame.ts";
import type { ScenarioContext } from "./scenario.ts";

export interface ScenarioTestContextParts {
  readonly scenario: ScenarioDefinition;
  readonly call: ScenarioContext["call"];
  /** The lane the driver runs in; the zero frame (a plain `mine-labs run`) when omitted. */
  readonly arena?: ArenaFrame;
  /** The shared fake bot unless a test needs it placed or loaded. */
  readonly bot?: Bot;
  readonly client?: Partial<ScenarioContext["client"]>;
}

/** Ticks pass at once, physics has no state, and the client's world is the bot's (`body`) with `setCell` recorded nowhere unless given. */
export function scenarioTestContext(parts: ScenarioTestContextParts): ScenarioContext {
  const bot = parts.bot ?? createFakeBot().bot;
  return {
    scenario: parts.scenario,
    arena: parts.arena ?? arenaFrame(ZERO_ARENA),
    bot,
    waitForTicks: async () => {},
    physics: { pause: () => {}, resume: () => {} },
    client: {
      setCell: async () => {},
      body: () => ({ ...bot.entity.position, onGround: bot.entity.onGround }),
      windowsOpened: () => 0,
      ...parts.client,
    },
    call: parts.call,
  };
}
