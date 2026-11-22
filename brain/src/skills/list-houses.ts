// Reading the houses of one family (list_houses): their catalogue lines, each with the step that builds it.
import type { Step } from "../actions.ts";
import { catalogueLine } from "../building/plan.ts";
import { familiesOf, TEMPLATES, type Template } from "../building/templates.ts";
import type { SkillResult } from "../skills.ts";

/**
 * Reads the houses of one family, the character's own included: ends `done` at once with its catalogue lines, each ending
 * with the step that builds it; a family nobody knows fails with the families that exist. No body call. Its detail never
 * starts with "built": the run analysis counts `done` + "built..." as a house.
 */
export function listHouses(step: Extract<Step, { skill: "list_houses" }>, templates: ReadonlyMap<string, Template> = TEMPLATES): SkillResult {
  const houses = [...templates.values()].filter((template) => template.family === step.family);
  if (houses.length === 0) return { status: "failed", detail: `no houses of the family ${JSON.stringify(step.family)};the families you know: ${familiesOf(templates).join(", ")}` };
  return { status: "done", detail: houses.map(listedLine).join("\n") };
}

/** A catalogue line of `list_houses`, ending with the step that builds that house. */
const listedLine = (template: Template): string => `${catalogueLine(template)}: {"skill":"build","template":"${template.id}"}`;
