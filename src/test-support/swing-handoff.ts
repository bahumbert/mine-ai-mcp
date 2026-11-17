// Run the real fight's sword readiness and strike after another body owner's attack.
import type { Bot } from "mineflayer";
import { DEFAULT_SURVIVAL_POLICY } from "../survival/policy/contract.js";
import type { FightScene } from "../survival/responses/fight/scene.js";
import { FightWeapons } from "../survival/responses/fight/weapons.js";

/** Only the surrounding fight lifecycle is inert; recovery, facing and the strike run normally. */
export async function fightSwordAfter(bot: Bot, targetId: number): Promise<boolean> {
  const scene = {
    bot, target: bot.entities[targetId]!, targetId, policy: DEFAULT_SURVIVAL_POLICY,
    signal: new AbortController().signal, elapsedTicks: 0, attacks: 0,
    perception: { read: () => [], attackerIds: new Set<number>() },
    footingRecovery: { needed: false }, dead: new Set<number>(),
    stylesUsed: new Set(), weaponsUsed: new Set(), settled: () => false,
    reportDecision: () => {},
    execution: { run: async (_phase: string, effect: () => Promise<unknown>) => effect() },
  } as unknown as FightScene;
  const tick = () => { scene.elapsedTicks++; };
  bot.on("physicsTick", tick);
  try {
    const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
    const loadout = { kind: "melee", weapon: bot.heldItem, shield: null, cooldownTicks: 13 } as const;
    await weapons.readyWeapon(loadout);
    return weapons.strike(scene.target, loadout);
  } finally {
    bot.off("physicsTick", tick);
  }
}
