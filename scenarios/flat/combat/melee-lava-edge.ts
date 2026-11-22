import { Vec3 } from "vec3";
import { ScenarioCombat } from "../../src/combat.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { hasMeleeKnockbackRoom } from "../../../src/survival/weapons/melee.ts";

/** A measured server impulse at the first swing tests the stance chosen before contact. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Initial ledge did not settle");
  const target = Object.values(bot.entities).find((e) => e.name === "magma_cube");
  if (!target) throw new Error("The arranged cube was not observed");
  const attack = bot.attack.bind(bot);
  let firstSwing: Vec3 | null = null;
  let targetAtSwing: Vec3 | null = null;
  let impulseHeard = false;
  let afterSwing = 0;
  let minimumHealth = bot.health;
  let touchedLava = false;
  bot.attack = (...args) => {
    if (!firstSwing) {
      firstSwing = bot.entity.position.clone();
      targetAtSwing = target.position.clone();
      // A facing shield blocks /damage entirely; lowering it sent a real 0.4 horizontal impulse (probe 2026-11-08).
      bot.deactivateItem();
      bot.chat(`/damage ${bot.username} 1 minecraft:mob_attack by @e[type=magma_cube,sort=nearest,limit=1,distance=..8]`);
    }
    attack(...args);
  };
  const velocity = (packet: { entityId: number }) => {
    if (firstSwing && packet.entityId === bot.entity.id) impulseHeard = true;
  };
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    touchedLava ||= Reflect.get(bot.entity, "isInLava") === true;
    if (firstSwing && ++afterSwing === 2) bot.chat("/kill @e[type=magma_cube]");
  };
  bot.on("physicsTick", tick);
  bot._client.on("entity_velocity", velocity);
  try {
    using combat = new ScenarioCombat(bot, navigation);
    const outcome = await combat.controller.engage(target.id, signal, "pursue");
    await bot.waitForTicks(20);
    const knockbackRoom = firstSwing !== null && targetAtSwing !== null &&
      hasMeleeKnockbackRoom(navigation.world, firstSwing, targetAtSwing);
    return {
      status:
        outcome.kind === "died" && firstSwing !== null && knockbackRoom && impulseHeard &&
        minimumHealth >= 19 && !touchedLava && bot.entity.onGround
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        outcome,
        firstSwing,
        targetAtSwing,
        knockbackRoom,
        impulseHeard,
        minimumHealth,
        touchedLava,
        final: bot.entity.position,
        grounded: bot.entity.onGround,
      }),
    };
  } finally {
    bot.attack = attack;
    bot.off("physicsTick", tick);
    bot._client.off("entity_velocity", velocity);
  }
};
