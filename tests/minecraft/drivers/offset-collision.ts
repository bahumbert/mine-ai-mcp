import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ArenaFrame } from "../arena/frame.ts";
import type { ScenarioContext } from "../scenario.ts";
import { BODY_HALF_WIDTH, serverBoxes } from "./offset-stalk-boxes.ts";

/** `stalks[].at` is arena-local in the YAML and a world cell here: the bamboo offset depends on the world cell, so the lane's cell is the one checked. */
const paramsIn = (arena: ArenaFrame) => z.strictObject({
  debugExecuteJavaScript: z.literal(true),
  stalks: z.array(z.strictObject({
    at: z.tuple([z.number().int(), z.number().int(), z.number().int()]).transform((cell) => arena.world(cell)),
  })).min(1),
});

const probeReportSchema = z.strictObject({
  startX: z.number(),
  startZ: z.number(),
  endX: z.number(),
  endZ: z.number(),
  corrections: z.number().int(),
  stateId: z.number().int(),
  /** The stalk cell the program worked out from where the body stood, to be the one the driver asked for. */
  stalk: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
});

const STOP_TOLERANCE = 0.01;
const WALK_TICKS = 20;

type Axis = "x" | "z";
interface Side {
  readonly name: string;
  readonly axis: Axis;
  /** +1 walks toward larger coordinates: the approach cell is one below the stalk on that axis. */
  readonly direction: 1 | -1;
}
const SIDES: readonly Side[] = [
  { name: "west", axis: "x", direction: 1 },
  { name: "east", axis: "x", direction: -1 },
  { name: "north", axis: "z", direction: 1 },
  { name: "south", axis: "z", direction: -1 },
];

/**
 * The code run inside the host's bot: centre in the approach cell, count `forcedMove` events while walking straight at
 * the stalk, report where the body stopped, and walk back to the approach cell's centre. Positions are read from the bot, never assumed.
 * The program holds no coordinate: it finds the approach cell where the body stands (the driver navigated there) and the stalk
 * one cell on from it, so the same program runs in every lane; it reports the stalk cell for the driver to check.
 */
function probeProgram(side: Side): string {
  const along = side.axis === "x" ? "sx" : "sz";
  const farEdge = `${along} + ${side.direction > 0 ? 1 + BODY_HALF_WIDTH : -BODY_HALF_WIDTH}`;
  return `
    const standing = bot.entity.position;
    const ax = Math.floor(standing.x), ay = Math.floor(standing.y + 0.01), az = Math.floor(standing.z);
    const sx = ax + ${side.axis === "x" ? side.direction : 0}, sz = az + ${side.axis === "z" ? side.direction : 0};
    const cx = ax + 0.5, cz = az + 0.5;
    const eye = 1.62;
    const centre = async () => {
      for (let tick = 0; tick < 40; tick += 1) {
        const p = bot.entity.position;
        const distance = Math.hypot(cx - p.x, cz - p.z);
        if (distance <= 0.03) break;
        await bot.lookAt(new Vec3(cx, p.y + eye, cz), true);
        bot.setControlState("sneak", distance < 0.5);
        bot.setControlState("forward", true);
        await bot.waitForTicks(1);
      }
      bot.clearControlStates();
      await bot.waitForTicks(10);
    };
    await centre();
    let corrections = 0;
    const onForcedMove = () => { corrections += 1; };
    bot.on("forcedMove", onForcedMove);
    const start = bot.entity.position.clone();
    const target = new Vec3(start.x + ${side.axis === "x" ? 5 * side.direction : 0}, start.y + eye, start.z + ${side.axis === "z" ? 5 * side.direction : 0});
    await bot.lookAt(target, true);
    bot.setControlState("forward", true);
    for (let tick = 0; tick < ${WALK_TICKS}; tick += 1) {
      if ((bot.entity.position.${side.axis} - (${farEdge})) * ${side.direction} > 0) break;
      await bot.waitForTicks(1);
    }
    bot.clearControlStates();
    await bot.waitForTicks(10);
    bot.off("forcedMove", onForcedMove);
    const end = bot.entity.position.clone();
    // Leave the stalk's cell before the next side: a walk can stop with the centre inside it, and the next navigate
    // must not start from there (Task 5 covers that state). Nothing is counted for the way back.
    await centre();
    return JSON.stringify({
      startX: start.x, startZ: start.z, endX: end.x, endZ: end.z, corrections,
      stalk: [sx, ay, sz],
      stateId: bot.world.getBlockStateId(new Vec3(sx, ay, sz)),
    });
  `;
}

/** Where a body centred at `start` stops walking along `side` into the boxes, or null when it walks past them. */
function expectedStop(boxes: readonly (readonly number[])[], side: Side, startCross: number): number | null {
  const [along, crossMin, crossMax] = side.axis === "x" ? [0, 2, 5] : [2, 0, 3];
  const hit = boxes.filter((box) => startCross + BODY_HALF_WIDTH > box[crossMin]! + 1e-9 && startCross - BODY_HALF_WIDTH < box[crossMax]! - 1e-9);
  if (hit.length === 0) return null;
  return side.direction > 0
    ? Math.min(...hit.map((box) => box[along]!)) - BODY_HALF_WIDTH
    : Math.max(...hit.map((box) => box[along + 3]!)) + BODY_HALF_WIDTH;
}

/** Walk straight at every stalk from its four sides; the server's stalk is the oracle (no correction, flush stop). */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { stalks } = paramsIn(context.arena).parse(context.scenario.params);
  const lines: string[] = [];
  let failed = false;
  for (const { at } of stalks) {
    for (const side of SIDES) {
      const label = `${at.join(",")} ${side.name}`;
      const approach = side.axis === "x" ? { x: at[0] - side.direction, z: at[2] } : { x: at[0], z: at[2] - side.direction };
      const arrival = await context.call("navigate", { ...approach, y: at[1], range: 0, dig: false, scaffold: false });
      if (arrival.result.status !== "succeeded") return { status: "failed", detail: `${label}: navigate ${arrival.summary}; ${lines.join("; ")}` };
      const probe = await context.call("debug_execute_javascript", { code: probeProgram(side) });
      const execution = (probe.result as { readonly execution?: { readonly value: string } }).execution;
      const json = execution?.value.slice(execution.value.indexOf("{"), execution.value.lastIndexOf("}") + 1);
      if (json === undefined || json === "") return { status: "failed", detail: `${label}: probe gave ${probe.summary}; ${lines.join("; ")}` };
      const report = probeReportSchema.parse(JSON.parse(json));
      if (report.stalk.join() !== at.join()) return { status: "failed", detail: `${label}: the body stood beside ${report.stalk.join(",")}, not the stalk; ${lines.join("; ")}` };
      const boxes = serverBoxes(at, report.stateId);
      const expected = expectedStop(boxes, side, side.axis === "x" ? report.startZ : report.startX);
      const got = side.axis === "x" ? report.endX : report.endZ;
      const farEdge = side.axis === "x" ? at[0] : at[2];
      const stopOk = expected === null ? (got - farEdge - (side.direction > 0 ? 1 : 0)) * side.direction > 0 : Math.abs(got - expected) <= STOP_TOLERANCE;
      const ok = report.corrections === 0 && stopOk;
      failed ||= !ok;
      lines.push(`${label}: ${ok ? "ok" : "FAIL"} stop ${got.toFixed(3)}/${expected === null ? "past" : expected.toFixed(3)}, corrections ${report.corrections}`);
    }
  }
  return { status: failed ? "failed" : "succeeded", detail: lines.join("; ") };
}
