/** The swords' damage and recovery: the first part of `weapon-tools.ts`' table. */
import type { ContractCheck } from "../checks.ts";
import { TOOLS_BY_KIND, weaponToolsCheck } from "./weapon-tools.ts";

export const weaponDamageSwords: ContractCheck = weaponToolsCheck("weapon-damage-swords", TOOLS_BY_KIND.sword);
