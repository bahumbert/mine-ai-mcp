// The agent's list of protected areas, kept in place by the skills that protect or release one; the overlap tests live in `protected-areas.ts`.
import type { ProtectedArea } from "../runtime-client.ts";
import type { SkillContext } from "../skills.ts";

export { describeOverlaps, LEVELING_LABEL, overlapsOf } from "../protected-areas.ts";

export function noteArea(context: SkillContext, area: ProtectedArea): void {
  if (context.areas === undefined) return;
  const index = context.areas.findIndex((known) => known.regionId === area.regionId);
  if (index === -1) context.areas.push(area);
  else context.areas[index] = area;
}
