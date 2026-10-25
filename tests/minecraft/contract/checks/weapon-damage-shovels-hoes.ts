/** The shovels and the hoes' damage and recovery: the fourth part of `weapon-tools.ts`' table. */
import type { ContractCheck } from "../checks.ts";
import { TOOLS_BY_KIND, weaponToolsCheck } from "./weapon-tools.ts";

export const weaponDamageShovelsHoes: ContractCheck = weaponToolsCheck("weapon-damage-shovels-hoes", [...TOOLS_BY_KIND.shovel, ...TOOLS_BY_KIND.hoe]);
