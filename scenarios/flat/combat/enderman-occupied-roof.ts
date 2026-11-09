/** Prove the defending branch searches beyond an actually occupied local roof layer. */
import assert from "node:assert/strict";
import { createMovements } from "../../../src/navigation/index.ts";
import { hunt } from "../../../src/navigation/processes/hunting/hunt-process.ts";
import { CombatPosition } from "../../../src/survival/positioning/combat/position.ts";
import type { CombatDecision } from "../../../src/survival/control/combat/contract.ts";
import { armSignal } from "../../../src/utils/signals.ts";
import { entityMetadata } from "../../../src/world/end-fight.ts";
import { standStill, wearArmor } from "../../src/runtime.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import type { MineAiScenarioContext, MineAiScenario } from "../../src/scenario-client.ts";

/** AngryAt identifies this player; the native server's creepy metadata acknowledges target acquisition. */
async function angerQuarry(context: MineAiScenarioContext, target: MineAiScenarioContext["bot"]["entity"]): Promise<void> {
  const { bot, signal } = context;
  // minecraft-data pc/1.21.4/entities.json: Enderman metadataKeys[17] = creepy; [15] = mob_flags.
  const angryFlag = bot.registry.entitiesByName.enderman.metadataKeys!.indexOf("creepy");
  const acknowledged = armSignal(bot, "entityUpdate", () => entityMetadata(bot, target, "creepy") === true,
    { context: { signal } });
  const uuid = Buffer.from(bot.player.uuid.replaceAll("-", ""), "hex");
  const angryAt = [0, 4, 8, 12].map(offset => uuid.readInt32BE(offset)).join(",");
  try {
    bot.chat(`/data merge entity @e[tag=roof_quarry,limit=1,distance=..24] {AngerTime:600,AngryAt:[I;${angryAt}]}`);
    assert.equal((await acknowledged.settle(10_000)).kind, "signalled", "native anger must precede the hunt");
    context.log(`ANGER_ACK target=${target.id} metadata[${angryFlag}]=true`);
  } finally { acknowledged.cancel(); }
}

export const run: MineAiScenario = async context => {
  const { bot, navigation, signal } = context;
  assert.ok(await standStill(context));
  await wearArmor(context);
  const target = bot.nearestEntity(entity => entity.name === "enderman")!;
  assert.ok(target);
  using owner = new ScenarioCombat(bot, navigation);
  const position = new CombatPosition(bot, navigation, target, new Set(), owner.perception,
    () => owner.controller.policy.combat, owner.survival.answered);
  const start = position.cell;
  const pen = target.position.floored();
  const local = position.planRoof({ kind: "protection" });
  context.log(`LOCAL_ROOF ${JSON.stringify(local)}`);
  assert.equal(local.kind, "unreachable");
  if (local.kind === "unreachable") assert.match(local.reason, /1 supported cells;.*occupied [1-9]/);
  await angerQuarry(context, target);
  const roofs: Extract<CombatDecision, { kind: "roof_prepared" }>[] = [];
  let released = false;
  const stopObserving = owner.controller.onDecision(event => {
    if (event.kind === "roof_prepared") { roofs.push(event); context.log(`roof_prepared ${JSON.stringify(event)}`); }
    if (event.kind === "roof_prepared" && event.stopped === null && event.cell.y === start.y - 2 && !released) {
      released = true;
      const from = pen.offset(-1, 0, -1), to = pen.offset(1, 2, 1);
      bot.chat(`/fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} air replace stone`);
    }
  });
  let defeated = false;
  try {
    const result = await hunt(bot, {
      matches: entity => entity.id === target.id && entity.isValid,
      isSatisfied: () => defeated, movements: createMovements(bot), route: navigation.navigate, signal,
      // Admit the engagement at its arranged ledge before the hunt's ordinary closing route can leave that layer.
      contactRange: 24,
      engage: async id => {
        const outcome = await owner.controller.engage(id, signal, "pursue");
        context.log(`ENGAGEMENT ${JSON.stringify(outcome)}`);
        if (outcome.kind === "died") { defeated = true; return { kind: "defeated" }; }
        return { kind: "unreachable", reason: "observation" in outcome ? outcome.observation : outcome.kind };
      },
    });
    const builtBelow = roofs.some(event => event.stopped === null && event.cell.y === start.y - 2);
    const passed = builtBelow && defeated && bot.health > 0;
    return { status: passed ? "succeeded" : "failed", detail: JSON.stringify({ builtBelow, roofs, health: bot.health, result }) };
  } finally { stopObserving(); owner.survival.answered.clear(); }
};
