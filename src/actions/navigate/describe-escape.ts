/** The navigate result's line for an escape that set one of the model's own rules aside. */
import { RELAXED_DIG_STRAIGHT_DOWN, RELAXED_FLOWING_WATER } from "../../navigation/index.js";

/** The line that tells the model which rule of its own was set aside once to get it out of a pocket, and what that dug. */
export function describeEscape(relaxed: readonly string[]): string {
  const flowing = relaxed.includes(RELAXED_FLOWING_WATER);
  if (!relaxed.includes(RELAXED_DIG_STRAIGHT_DOWN))
    return "- Dug out of a pocket beside flowing water: a dig that lets in flowing water was allowed once (a water source and lava still refuse).";
  return `- Dug down out of a pocket: your rule against digging straight down was set aside once${flowing ? " and a dig next to flowing water was allowed" : ""}.`;
}
