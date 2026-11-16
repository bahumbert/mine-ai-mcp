// Place a sign and obtain its server-confirmed front text.
import type { Bot } from "mineflayer";
import type { SqlBotData } from "../../bot-data/index.js";
import { recordOwnSign } from "../../bot-data/index.js";
import { Vec3 } from "vec3";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import { familyMembers, signBlockFor } from "../../world/item-families.js";
import { isReplaceableForPlacement } from "../../world/block-classification.js";
import { placeBlock, type InventoryItem, type WorldBlock } from "../../world/placement.js";
import { recordPlacementSent, startOwnPlacement, type OwnPlacement } from "../../world/own-placement.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { raceSignal, cellIntersectsPlayerBody } from "../../utils/index.js";
import { defineAction, type ActionContext } from "../action.js";
import { approachTarget, isPlacementSupport } from "../place-block/place-block.js";
import { readSignAt } from "../read-signs/read-signs.js";
import { watchSignAnswers, type SignAnswers } from "./sign-answers.js";
import { PLACE_SIGN, PLACE_SIGN_DESCRIPTION, normalizeLines, parsePlaceSignRequest, placeSignInputSchema, placeSignResultSchema, placeSignCheckpointSchema, placeSignAnnotations, placeSignOutcomes, type PlaceSignRequest, type PlaceSignResult, type SignLines } from "./contract.js";

export interface PlaceSignDependencies { readonly bot: Bot; readonly botData: SqlBotData; readonly navigation: NavigationRuntime }

interface SignRun {
  readonly deps: PlaceSignDependencies;
  readonly request: PlaceSignRequest;
  readonly target: Vec3;
  readonly lines: SignLines;
  readonly own: OwnPlacement;
  phase: "approach" | "sent" | "placed" | "edit_sent" | "written";
}

/** Unit vectors in the caller's requested text direction. */
function facingVector(facing: PlaceSignRequest["facing"]): Vec3 {
  switch (facing) {
    case "north": return new Vec3(0, 0, -1);
    case "south": return new Vec3(0, 0, 1);
    case "east": return new Vec3(1, 0, 0);
    case "west": return new Vec3(-1, 0, 0);
  }
}

/** Report the block and lines actually read, alongside what this call confirmed. */
function evidence(run: SignRun, placed = false, confirmed = false): PlaceSignResult["sign"] {
  const { bot } = run.deps;
  const reading = readSignAt(bot, run.target);
  return { target: { x: run.target.x, y: run.target.y, z: run.target.z }, block: bot.blockAt(run.target)?.name ?? null,
    facing: run.request.facing, attach: run.request.attach, lines: normalizeLines(reading?.front ?? []), placed, confirmed };
}

/** A refusal before an owned placement. */
function refusal(run: SignRun, error: string): PlaceSignResult {
  return { status: "failed", error, sign: evidence(run) };
}

interface SignPlacement { readonly item: InventoryItem; readonly block: string; readonly support: WorldBlock; readonly face: Vec3 }

/** Select a carried family member and the exact requested support, never another face. */
function planPlacement(run: SignRun): SignPlacement | PlaceSignResult {
  const { bot } = run.deps;
  const members = familyMembers(bot, "sign");
  const item = bot.inventory.items().find((item) => members.includes(item.name) && (run.request.sign_item === undefined || item.name === run.request.sign_item));
  if (!item) return { ...refusal(run, placeSignOutcomes.noItem), members: [...members] };
  const current = bot.blockAt(run.target);
  if (!current) return refusal(run, placeSignOutcomes.unloaded);
  const sign = readSignAt(bot, run.target);
  if (sign || !isReplaceableForPlacement(current, bot.version)) return { ...refusal(run, placeSignOutcomes.taken(current.name)), existing: { block: current.name, ...(sign && { front: sign.front }) } };
  const face = run.request.attach === "ground" ? new Vec3(0, 1, 0) : facingVector(run.request.facing);
  const support = bot.blockAt(run.target.minus(face));
  const block = signBlockFor(bot, item.name, run.request.attach);
  if (!isPlacementSupport(support) || block === null) return refusal(run, placeSignOutcomes.noSupport);
  return { item, block, support, face };
}

/** Record only complete text read from a sign this request put down. */
function recordPlacedSign(run: SignRun): void {
  const reading = readSignAt(run.deps.bot, run.target);
  if (reading?.known) recordOwnSign(run.deps.botData, run.deps.bot.username, { ...reading, dimension: run.deps.bot.game.dimension });
}

/** One synchronous Mineflayer write, with its emitted error captured for this call only. */
async function writeSign(run: SignRun, answers: SignAnswers, signal: AbortSignal): Promise<string | null> {
  const { bot } = run.deps;
  const block = bot.blockAt(run.target);
  if (!block) return "the sign cell became unloaded";
  signal.throwIfAborted();
  let error: Error | null = null;
  const onError = (cause: Error) => { error = cause; };
  const confirmed = answers.text(run.lines, bot.time?.age);
  confirmed.catch(() => undefined);
  bot.once("error", onError);
  try {
    run.phase = "edit_sent";
    bot.updateSign(block, run.lines.join("\n"));
  } finally {
    bot.removeListener("error", onError);
  }
  if (error) return (error as Error).message;
  return await confirmed ? null : "no matching block entity answer arrived";
}

/** Place once, then use the editor permission and a new text answer rather than elapsed ticks as success. */
async function placeAndWrite(run: SignRun, plan: SignPlacement, answers: SignAnswers, signal: AbortSignal): Promise<PlaceSignResult> {
  const { bot } = run.deps;
  const placed = await placeBlock(bot, { item: plan.item, support: plan.support, face: plan.face, expectedCells: [run.target],
    matches: (block) => block.name === plan.block, signal,
    ...(run.request.attach === "ground" && { lookDirection: facingVector(run.request.facing).scaled(-1) }),
    onSent: () => { recordPlacementSent(run.own, [run.target], bot.time?.age); run.phase = "sent"; } });
  signal.throwIfAborted();
  const didPlace = run.own.cells.length > 0 && bot.blockAt(run.target)?.name === plan.block;
  if (placed.kind === "failed" && !didPlace) return refusal(run, placed.error);
  run.phase = "placed";
  let cause = "the server did not open the sign editor";
  if (await answers.editor()) cause = await writeSign(run, answers, signal) ?? "";
  recordPlacedSign(run);
  if (cause) return { status: "partial", error: placeSignOutcomes.unconfirmed(plan.block, cause), sign: evidence(run, true) };
  run.phase = "written";
  return { status: "succeeded", sign: evidence(run, true, true) };
}

/** Scope every attempt's waits to its caller, logical lifetime and connection. */
async function executeSign(run: SignRun, lifetime: AbortSignal, context: ActionContext): Promise<PlaceSignResult> {
  const { bot, navigation } = run.deps;
  const stop = new AbortController();
  const signal = AbortSignal.any([lifetime, stop.signal, ...(context.signal ? [context.signal] : [])]);
  const onEnd = () => stop.abort(new Error("Disconnected while placing a sign"));
  const onDeath = () => stop.abort(new Error("Died while placing a sign"));
  bot.once("end", onEnd);
  bot.once("death", onDeath);
  let answers: SignAnswers | undefined;
  try {
    signal.throwIfAborted();
    const route = await raceSignal(approachTarget(bot, run.target, { signal }, { createMovements, navigate: navigation.navigate }), signal);
    if (route?.status === "stopped") return refusal(run, placeSignOutcomes.failed(route.reason));
    if (cellIntersectsPlayerBody(run.target, bot.entity.position)) return refusal(run, placeSignOutcomes.failed("The bot still occupies the sign cell"));
    const plan = planPlacement(run);
    if ("status" in plan) return plan;
    answers = watchSignAnswers(bot, run.target, signal);
    return await placeAndWrite(run, plan, answers, signal);
  } finally {
    answers?.dispose();
    bot.removeListener("end", onEnd);
    bot.removeListener("death", onDeath);
    stop.abort(new Error("Sign attempt ended"));
  }
}

/** Construct the request-owned sign action. */
export function createPlaceSignAction(deps: PlaceSignDependencies) {
  return defineAction({ name: PLACE_SIGN, description: PLACE_SIGN_DESCRIPTION, inputSchema: placeSignInputSchema, resultSchema: placeSignResultSchema,
    checkpointSchema: placeSignCheckpointSchema, formatResult: (result) => JSON.stringify(result), annotations: placeSignAnnotations,
    execution: { kind: "resumable_task", prepare: (signal) => prepareBotForMovement(deps.bot, deps.navigation, signal) }, parse: parsePlaceSignRequest,
    begin(request, lifetime, observe) {
      const run: SignRun = { deps, request, target: new Vec3(request.x, request.y, request.z), lines: normalizeLines(request.lines), own: startOwnPlacement(), phase: "approach" };
      observe(() => ({ baseline: { target: { x: request.x, y: request.y, z: request.z } }, checkpoint: { phase: run.phase }, completion: { kind: "event", observed: run.phase === "written", owes: "server-confirmed front text" } }));
      return (context) => executeSign(run, lifetime, context);
    } });
}
