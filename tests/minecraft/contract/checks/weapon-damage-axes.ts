/** The axes' damage and recovery: the second part of `weapon-tools.ts`' table. */
import type { ContractCheck } from "../checks.ts";
import { TOOLS_BY_KIND, weaponToolsCheck } from "./weapon-tools.ts";

export const weaponDamageAxes: ContractCheck = weaponToolsCheck("weapon-damage-axes", TOOLS_BY_KIND.axe);
