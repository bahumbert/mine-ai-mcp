// A server-triggered route invalidation must keep a committed parkour through landing and replanning.
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await using runtime = await openRuntime(context, "parkour-invalidation");
  let parkour = false;
  let invalidatedAirborne = false;
  let landed = false;
  let replanned = false;
  const stop = runtime.navigation.onEvent((event) => {
    if (event.kind === "step_started" && event.movement === "parkour") parkour = true;
    if (event.kind === "world_change" && event.classification === "invalidating")
      invalidatedAirborne ||= parkour && !bot.entity.onGround;
    if (event.kind === "search_started" && event.reason === "world_changed") replanned = true;
  });
  const observeLanding = () => {
    landed ||= invalidatedAirborne && bot.entity.onGround && bot.entity.position.x >= 4 && bot.entity.position.y === -60;
  };
  bot.on("physicsTick", observeLanding);
  try {
    const navigate = runtime.actions.find((action) => action.name === "navigate");
    if (!navigate) throw new Error("The runtime has no navigate action.");
    const output = await runtime.run(navigate, { x: 10, y: -60, z: 0, range: 0.5, dig: false, scaffold: false }, signal);
    const evidence = { parkour, invalidatedAirborne, landed, replanned, result: output.result };
    return {
      status: output.result.status === "succeeded" && invalidatedAirborne && landed && replanned ? "succeeded" : "failed",
      detail: JSON.stringify(evidence),
    };
  } finally {
    stop();
    bot.off("physicsTick", observeLanding);
  }
};
