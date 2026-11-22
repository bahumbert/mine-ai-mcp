// Observe real body support at each physical swing in mining regression scenarios.
import { z } from "zod";
import { Vec3 } from "vec3";
import type { ClientCompletion } from "mine-labs/client";
import { footprintStandsOnCell } from "../../../src/world/player-physics.ts";
import { isSafeSupport } from "../../../src/navigation/world/block-geometry.ts";
import { liveBlockReader } from "../../../src/navigation/mineflayer/world.ts";
import { createMovements, createNavigationRuntime } from "../../../src/navigation/runtime.ts";
import { castOntoPool } from "../../../src/navigation/processes/mining/cast-obsidian.ts";
import { useItemAt } from "../../../src/world/item-use.ts";
import { arenaActionInput } from "../arena/frame.ts";
import { arenaCell } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { forbidDigStraightDown } from "./styled-navigate.ts";

type Point = { x: number; y: number; z: number };
type Swing = { target: Point; body: Point; depends: boolean; path: Point[] };
const copy = ({ x, y, z }: Point): Point => ({ x, y, z });
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y && a.z === b.z;

/** Require a target swing after the scenario's lava face was plugged. */
export function requireSealedTargetSwing(faceAtSwings: (string | undefined)[]): void {
  if (!faceAtSwings.includes("cobblestone")) throw new Error(`missing sealed target swing: ${JSON.stringify(faceAtSwings)}`);
}

/** Require a real target swing with evidence of its approach and classify its support. */
export function classifyTargetSwings(swings: Swing[], target: Point): string[] {
  const relevant = swings.filter((swing) => same(swing.target, target));
  if (!relevant.length) throw new Error(`missing target swing ${JSON.stringify(target)}; swings=${JSON.stringify(swings)}`);
  return relevant.map(({ body, depends, path }) => {
    if (!path.length) throw new Error("missing navigation path before target swing");
    const centred = Math.floor(body.x) === target.x && Math.floor(body.z) === target.z;
    if (depends && !centred) throw new Error(`unsafe target edge swing: ${JSON.stringify({ target, body, path })}`);
    return depends && centred ? "centred downward" : "bank";
  });
}

/** Exercise dry in-place admission before the next registered collection chooses its safe stance. */
async function probeDryEdge(context: ScenarioContext, target: Point, swings: Swing[]): Promise<string> {
  await using navigation = createNavigationRuntime(context.bot);
  const result = await navigation.breakBlockInPlace({
    movements: createMovements(context.bot), position: target, retainSupport: true,
  });
  if (result.status !== "failed" || result.cause !== "support" || swings.some((swing) => same(swing.target, target)))
    throw new Error(`dry edge did not refuse without target swing: ${JSON.stringify({ result, swings })}`);
  return result.reason;
}

/** Attempt the real casting work at the edge, then move to the bank and finish it. */
async function castFromBank(context: ScenarioContext, target: Point, source: Point, swings: Swing[]): Promise<string> {
  const { bot } = context;
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const ray = new Vec3(source.x + 0.5, source.y + 0.9, source.z + 0.5).minus(eye);
  const hit = bot.world.raycast(eye, ray.scaled(1 / ray.norm()), ray.norm());
  const hitPosition = hit && Reflect.get(hit, "position") as Point | undefined;
  if (!hitPosition || !same(hitPosition, target)) throw new Error(`lid ray missed: ${JSON.stringify({ eye, source, hit: hitPosition })}`);
  const navigation = createNavigationRuntime(bot);
  const physics = { useItem: useItemAt, breakInPlace: navigation.breakBlockInPlace, movements: createMovements(bot) };
  try {
    const first = await castOntoPool(bot, physics, [source]);
    if (first.kind !== "reposition" || swings.some((swing) => same(swing.target, target)))
      throw new Error(`edge casting did not reposition without lid swing: ${JSON.stringify({ first, swings })}`);
    const moved = await context.call("navigate", arenaActionInput({ x: 2, y: -60, z: 0, range: 0, dig: false, scaffold: false }, context.arena));
    if (moved.result.status !== "succeeded") throw new Error(`bank navigation: ${moved.summary}`);
    const second = await castOntoPool(bot, physics, [source]);
    if (second.kind !== "cast" || second.obsidianFormed < 1) throw new Error(`bank cast: ${JSON.stringify({ second, body: bot.entity.position, swings })}`);
    await navigation.close();
    const mined = await context.call("collect_block", { block_name: "obsidian", count: 1, scaffold: false });
    if (mined.result.status !== "succeeded") throw new Error(`next mining action: ${mined.summary}`);
    return `edge=${JSON.stringify(first)}; bank=${JSON.stringify(second)}; ${moved.summary}; ${mined.summary}`;
  } finally { await navigation.close(); }
}

/** Run an action while recording live body support immediately before every dig. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { action, input, target, source, seal, probeInPlace, noDigStraightDown } = z.strictObject({
    action: z.string(), input: z.record(z.string(), z.unknown()), target: arenaCell(context.arena),
    source: arenaCell(context.arena).optional(),
    seal: arenaCell(context.arena).optional(),
    probeInPlace: z.boolean().default(false),
    noDigStraightDown: z.boolean().default(false),
  }).parse(context.scenario.params);
  const { bot } = context;
  const read = liveBlockReader(bot);
  const depends = (body: Point, cell: Point) => cell.y === Math.ceil(body.y) - 1 &&
    footprintStandsOnCell(body, cell, (x, y, z) => isSafeSupport(read(x, y, z)));
  await context.waitForTicks(2);
  const initial = copy(bot.entity.position);
  if (!depends(initial, target)) return { status: "failed", detail: `initial edge lost: ${JSON.stringify({ initial, target })}` };
  const path: Point[] = [initial];
  const swings: Swing[] = [];
  const faceAtSwings: (string | undefined)[] = [];
  const sample = () => { path.push(copy(bot.entity.position)); };
  const dig = bot.dig;
  const originalDig = dig.bind(bot);
  bot.on("physicsTick", sample);
  bot.dig = async (block, forceLook, face?: Vec3 | "auto" | "raycast") => {
    const body = copy(bot.entity.position);
    const swing = { target: copy(block.position), body, depends: depends(body, block.position), path: [...path] };
    swings.push(swing);
    if (seal && same(swing.target, target)) faceAtSwings.push(bot.blockAt(new Vec3(seal.x, seal.y, seal.z))?.name);
    if (swing.depends && (Math.floor(body.x) !== block.position.x || Math.floor(body.z) !== block.position.z))
      throw new Error(`unsafe target edge swing: ${JSON.stringify(swing)}`);
    if (face !== undefined) return await originalDig(block, forceLook ?? false, face);
    return await originalDig(block, forceLook);
  };
  try {
    if (noDigStraightDown) {
      const refused = await forbidDigStraightDown(context);
      if (refused) return refused;
    }
    if (source) {
      const result = await castFromBank(context, target, source, swings);
      return { status: "succeeded", detail: `${result}; initial=${JSON.stringify(initial)}; swings=${JSON.stringify(swings)}; paths=${classifyTargetSwings(swings, target)}` };
    }
    const probe = probeInPlace ? await probeDryEdge(context, target, swings) : null;
    const output = await context.call(action, arenaActionInput(input, context.arena));
    if (output.result.status !== "succeeded") throw new Error(`action: ${output.summary}; swings=${JSON.stringify(swings)}`);
    const classification = classifyTargetSwings(swings, target);
    if (seal) requireSealedTargetSwing(faceAtSwings);
    const block = bot.blockAt(new Vec3(target.x, target.y, target.z));
    const detail = `${output.summary}; initial=${JSON.stringify(initial)}; probe=${probe}; swings=${JSON.stringify(swings)}; paths=${classification.join(", ")}; sealed=${JSON.stringify(faceAtSwings)}; target=${block?.name}`;
    return { status: output.result.status === "succeeded" && block?.name === "air" ? "succeeded" : "failed", detail };
  } catch (error) {
    return { status: "failed", detail: String(error) };
  } finally {
    bot.dig = dig;
    bot.off("physicsTick", sample);
  }
}
