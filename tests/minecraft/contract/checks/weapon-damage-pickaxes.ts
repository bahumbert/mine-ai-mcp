/** The pickaxes' damage and recovery: the third part of `weapon-tools.ts`' table. */
import type { ContractCheck } from "../checks.ts";
import { TOOLS_BY_KIND, weaponToolsCheck } from "./weapon-tools.ts";

export const weaponDamagePickaxes: ContractCheck = weaponToolsCheck("weapon-damage-pickaxes", TOOLS_BY_KIND.pickaxe);
