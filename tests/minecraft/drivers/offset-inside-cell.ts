import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ArenaFrame } from "../arena/frame.ts";
import type { ScenarioContext } from "../scenario.ts";
import { BODY_HALF_WIDTH, serverBoxes } from "./offset-stalk-boxes.ts";

/** `stalk` is arena-local in the YAML and a world cell here: the stalk's sideways offset depends on its world cell. */
const paramsIn = (arena: ArenaFrame) => z.strictObject({
  debugExecuteJavaScript: z.literal(true),
  stalk: z.tuple([z.number().int(), z.number().int(), z.number().int()]).transform((cell) => arena.world(cell)),
});

/** How far a stop must lie inside the stalk's cell for it to count as inside. */
const INSIDE_MARGIN = 0.05;
const WALK_TICKS = 20;
/** Cells from the stalk to the far side the route goes to and to the free side it ends on. */
const ROUTE_REACH = 5;

const COUNT_CORRECTIONS = "globalThis.offsetCorrections = 0; bot.on('forcedMove', () => { globalThis.offsetCorrections += 1; }); return 'counting';";
const NO_CORRECTIONS = "if (globalThis.offsetCorrections > 0) throw new Error('the server put the bot back ' + globalThis.offsetCorrections + ' times'); return 'no corrections';";
/** The state of the cell east of the cell the body stands in (the approach from the west): no coordinate in the program. */
const READ_STALK_STATE = "const p = bot.entity.position; return JSON.stringify({ stateId: bot.world.getBlockStateId(new Vec3(Math.floor(p.x) + 1, Math.floor(p.y + 0.01), Math.floor(p.z))) });";

/**
 * The code run inside the host's bot: centre in the approach cell the body stands in, walk `direction` (+1 east, -1 west) at
 * the stalk next to it for a while and report the stop; it throws when the body did not stop inside the stalk's cell.
 */
function walkIntoStalkCell(direction: 1 | -1): string {
  return `
    const eye = 1.62;
    const cellX = Math.floor(bot.entity.position.x);
    const cx = cellX + 0.5, cz = Math.floor(bot.entity.position.z) + 0.5;
    for (let tick = 0; tick < 40; tick += 1) {
      const p = bot.entity.position;
      const distance = Math.hypot(cx - p.x, cz - p.z);
      if (distance <= 0.03) break;
      await bot.lookAt(new Vec3(cx, p.y + eye, cz), true);
      bot.setControlState('sneak', distance < 0.5);
      bot.setControlState('forward', true);
      await bot.waitForTicks(1);
    }
    bot.clearControlStates();
    await bot.waitForTicks(10);
    await bot.lookAt(new Vec3(bot.entity.position.x + 5 * ${direction}, bot.entity.position.y + eye, bot.entity.position.z), true);
    bot.setControlState('forward', true);
    await bot.waitForTicks(${WALK_TICKS});
    bot.clearControlStates();
    await bot.waitForTicks(10);
    const x = bot.entity.position.x;
    if (Math.floor(x) !== cellX + ${direction}) throw new Error('did not stop inside the stalk cell: x ' + x);
    return 'inside the stalk cell at x ' + x;
  `;
}

/** The side a body can enter the stalk's cell from: west when the placed box leaves room before the cell's far edge, else east. */
function entrySide(stalk: readonly [number, number, number], stateId: number): 1 | -1 | null {
  const boxes = serverBoxes(stalk, stateId);
  const westStop = Math.min(...boxes.map((box) => box[0]!)) - BODY_HALF_WIDTH;
  if (westStop > stalk[0] + INSIDE_MARGIN) return 1;
  const eastStop = Math.max(...boxes.map((box) => box[3]!)) + BODY_HALF_WIDTH;
  return eastStop < stalk[0] + 1 - INSIDE_MARGIN ? -1 : null;
}

/**
 * Walk into the cell of a bamboo stalk, beside it, then to the far side, back, and to the free side; the server never puts the bot back.
 * The stalk's offset decides from which side the cell can be entered (a stalk leaning west leaves no room to the west of it), so
 * the side is read from the server's formula at the stalk's world cell.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { stalk } = paramsIn(context.arena).parse(context.scenario.params);
  const [x, y, z] = stalk;
  const summaries: string[] = [];
  const step = async (action: string, input: Record<string, unknown>): Promise<boolean> => {
    const output = await context.call(action, input);
    summaries.push(output.summary);
    return output.result.status === "succeeded";
  };
  const fail = (): ClientCompletion => ({ status: "failed", detail: summaries.join("; ") });
  const walk = (cellX: number) => step("navigate", { x: cellX, y, z, range: 0 });

  if (!(await step("debug_execute_javascript", { code: COUNT_CORRECTIONS }))) return fail();
  if (!(await walk(x - 1))) return fail();
  const read = await context.call("debug_execute_javascript", { code: READ_STALK_STATE });
  summaries.push(read.summary);
  const value = (read.result as { readonly execution?: { readonly value: string } }).execution?.value;
  const stateId = value === undefined ? undefined : (JSON.parse(value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1)) as { stateId?: number }).stateId;
  if (stateId === undefined) return fail();
  const side = entrySide(stalk, stateId);
  if (side === null) return { status: "failed", detail: `the stalk's box leaves no room to stand inside its cell from either side; ${summaries.join("; ")}` };

  const approach = x - side;
  const far = x + ROUTE_REACH * side;
  const route: readonly (() => Promise<boolean>)[] = [
    () => walk(approach),
    () => step("debug_execute_javascript", { code: walkIntoStalkCell(side) }),
    () => walk(far),
    () => walk(approach),
    () => step("debug_execute_javascript", { code: walkIntoStalkCell(side) }),
    () => walk(x - ROUTE_REACH),
    () => step("debug_execute_javascript", { code: NO_CORRECTIONS }),
  ];
  for (const leg of route) if (!(await leg())) return fail();
  return { status: "succeeded", detail: summaries.join("; ") };
}
