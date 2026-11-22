import type { BotEvents } from "mineflayer";
import { engageTarget } from "../../../src/actions/hunt-mob/hunt-mob.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

// recovery_timeout_ms sets two bounds. It is the recovery hold: 10,000 ms of game time is 200 world ticks at any server
// speed, and the default 90,000 ms hold outlasts this scenario's still guard. It is also the shelter build's wall
// deadline: builds measured 3.3-3.4 s at 20 tps and 5.5 s at 10 tps (factor 1.8 to 10,000 ms). A passing run's
// goal still span is 191-211 ticks (n 30).
const RECOVERY_HOLD_MS = 10_000;

/** Server-observed damage during a real engagement, without changing production combat policy. */
export const run: MineAiScenario = async ({ bot, navigation, signal }) => {
  const target = bot.nearestEntity((entity) => entity.name === "zombie");
  if (!target) return { status: "failed", detail: "The arranged zombie was not observed." };
  const stop = new AbortController();
  let hurt = false;
  let injected = false;
  let hitsAfterHurt = 0;
  const onHealth = () => {
    if (bot.health < 12) hurt = true;
  };
  const onHurt: BotEvents["entityHurt"] = (entity) => {
    if (entity.id !== target.id) return;
    if (hurt) {
      hitsAfterHurt++;
      stop.abort("The regression already observed an attack after the health boundary.");
    } else if (!injected) {
      injected = true;
      bot.chat(`/damage ${bot.username} 10 minecraft:generic`);
    }
  };
  bot.on("health", onHealth);
  bot.on("entityHurt", onHurt);
  try {
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    const policy = scenarioCombat1.controller.policy;
    await policy.edit({
      operation: "set",
      expected_revision: policy.snapshot().revision,
      changes: { combat: { recovery_timeout_ms: RECOVERY_HOLD_MS } },
      lifetime: { kind: "session" },
      reason: "the hostile-hunt-health fixture shortens the recovery hold it does not test",
    });
const { outcome } = await engageTarget(bot, scenarioCombat1.controller, target, {
      signal: AbortSignal.any([signal, stop.signal]),
    });
    return {
      status:
        hurt && hitsAfterHurt === 0 && outcome.kind === "capability_blocked" && outcome.reason === "recovery" && outcome.observation.includes("hold ran out")
          ? "succeeded"
          : "failed",
      detail: `health ${bot.health}; hurt ${hurt}; subsequent target hits ${hitsAfterHurt}; outcome ${outcome.kind}; attacks ${outcome.attacks}; observation ${"observation" in outcome ? outcome.observation : "none"}`,
    };
  } finally {
    bot.off("health", onHealth);
    bot.off("entityHurt", onHurt);
  }
};
