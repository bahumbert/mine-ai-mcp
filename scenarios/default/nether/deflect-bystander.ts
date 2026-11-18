// A forced ghast-owned shot with a neutral body on its return path.
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { observeIdleWindow } from "../../flat/combat/idle-reflex-window.ts";
import { secureCombatHandoff } from "../../../src/survival/control/combat/handoff.ts";
import type { Facts } from "../../../src/survival/state/answered.ts";
import { incomingFireball } from "../../../src/survival/perception/combat/fireball.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  using combat = new ScenarioCombat(bot, context.navigation);
  const bystander = Object.values(bot.entities).find((entity) => entity.name === "enderman");
  if (!bystander) throw new Error("Arranged Enderman was not loaded.");
  let spawned = false;
  let ballId: number | null = null;
  let botDamage = 0;
  let reflected = false;
  const damage: unknown[] = [];
  const explosions: unknown[] = [];
  const decisions: Facts[] = [];
  const onSpawn = (packet: { entityId: number; type: number }) => {
    if (packet.type !== bot.registry.entitiesByName.fireball!.id) return;
    spawned = true;
    ballId = packet.entityId;
  };
  const onDamage = (packet: { entityId: number; sourceCauseId: number }) => {
    if (packet.entityId === bystander.id) damage.push(packet);
    if (packet.entityId === bystander.id && packet.sourceCauseId === bot.entity.id + 1) botDamage++;
  };
  const onMove = () => { reflected ||= ballId !== null && (bot.entities[ballId]?.velocity.x ?? 0) > 0.05; };
  const onExplosion = (packet: unknown) => { explosions.push(packet); };
  bot._client.on("spawn_entity", onSpawn);
  bot._client.on("damage_event", onDamage);
  bot._client.on("explosion", onExplosion);
  bot.on("entityMoved", onMove);
  try {
    await bot.lookAt(bot.entity.position.offset(64, 1.62, 0), true);
    await observeIdleWindow(bot, 40, () => false, signal);
    const shooter = Object.values(bot.entities).find((entity) => entity.name === "ghast");
    if (!shooter?.uuid) throw new Error("Arranged ghast UUID was not loaded.");
    const owner = shooter.uuid.replaceAll("-", "").match(/.{8}/g)!.map((hex) => Number.parseInt(hex, 16) | 0).join(",");
    // NoAI ghasts never shoot (`deflect-fireball` contract, 2026-10-24). Arrange the native projectile past the bystander.
    bot.chat(`/execute at @s run summon minecraft:fireball ~2.5 ~1.5 ~ {Owner:[I;${owner}],Tags:["deflect_shot"],Motion:[-0.2d,0.0d,0.0d],acceleration_power:0.02d,ExplosionPower:1b}`);
    await observeIdleWindow(bot, 20, () => incomingFireball(bot, 16)?.id === ballId, signal);
    const result = await secureCombatHandoff(bot, context.navigation, combat.context, signal,
      (evidence) => { decisions.push(evidence); log(`DEFLECT DECISION ${JSON.stringify(evidence)}`); });
    await observeIdleWindow(bot, 40, () => {
      const ball = ballId === null ? undefined : bot.entities[ballId];
      reflected ||= (ball?.velocity.x ?? 0) > 0.05;
      return bot.health <= 0;
    }, signal);
    const alternative = decisions.some((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
      && "decision" in entry && entry.decision !== null && typeof entry.decision === "object"
      && "kind" in entry.decision && entry.decision.kind === "evade");
    const answers = combat.survival.answered.snapshot();
    const withheld = answers.some((entry) => entry.scope === `target:${ballId}` && entry.failure.kind === "deflection_unobserved");
    const detail = JSON.stringify({ spawned, ballId, botDamage, damage, explosions, reflected, health: bot.health,
      bystander: { id: bystander.id, position: bystander.position, valid: bystander.isValid }, alternative, withheld, result, answers });
    log(`DEFLECT BYSTANDER ${detail}`);
    return { status: spawned && withheld && botDamage === 0 && bot.health > 0 && alternative ? "succeeded" : "failed", detail };
  } finally {
    bot._client.off("spawn_entity", onSpawn);
    bot._client.off("damage_event", onDamage);
    bot._client.off("explosion", onExplosion);
    bot.off("entityMoved", onMove);
  }
};
