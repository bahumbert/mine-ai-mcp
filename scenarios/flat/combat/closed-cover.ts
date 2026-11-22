import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { observeIdleWindow } from "./idle-reflex-window.ts";
import { awaitEncounters, describe, readEncounters, readReflexOutcomes } from "./reflex.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const runtime = await openRuntime(context, "closed-cover");
  try {
    // Begin with a fresh event cursor and hold past the former 600-tick hide cooldown.
    await readEncounters(context, runtime);
    let violation: string | undefined;
    const lost = () => {
      const wallsIntact = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([x, z]) =>
        [-60, -59].every(y => bot.blockAt(new Vec3(x!, y, z!))?.name === "nether_bricks")) &&
        bot.blockAt(new Vec3(0, -58, 0))?.name === "nether_bricks";
      if (bot.health < 20 || !wallsIntact || bot.entity.position.distanceTo(new Vec3(0.5, -60, 0.5)) > 0.2) {
        violation ??= `Closed shelter lost: health ${bot.health}, walls intact ${wallsIntact}, position ${bot.entity.position}.`;
      }
      return violation !== undefined;
    };
    await observeIdleWindow(bot, 660, lost, signal);
    if (violation !== undefined) return { status: "failed", detail: violation };
    const wasBusy = runtime.status().busy;
    const { encounters: closedEncounters, limits, failures } = await readReflexOutcomes(context, runtime);
    if (wasBusy || runtime.status().busy || closedEncounters.length || limits.length || failures.length) {
      return { status: "failed", detail: "Closed shelter drew a hostile response before the fixture opened it." };
    }

    // The fixture opens the shelter; ordinary threat observation must respond
    // without waiting out another cooldown or requiring a model action.
    signal.throwIfAborted();
    bot.chat("/fill 1 -60 0 1 -59 0 air");
    const opened = () => [-60, -59].every((y) => bot.blockAt(new Vec3(1, y, 0))?.name === "air");
    await observeIdleWindow(bot, 40, opened, signal);
    if (!opened()) return { status: "failed", detail: "The fixture's wall opening was not seen" };
    const encounters = await awaitEncounters(context, runtime, 1, 400);
    const responded = encounters.some((encounter) =>
      encounter.outcome === "target_died" || encounter.outcome === "safe_separation");
    return {
      status: responded ? "succeeded" : "failed",
      detail: `Held closed cover for 660 server ticks, then opened it: ${encounters.map(describe).join(" | ")}`,
    };
  } finally {
    await runtime.close();
  }
};
