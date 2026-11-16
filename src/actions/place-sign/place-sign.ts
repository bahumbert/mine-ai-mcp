// Place a sign and obtain its server-confirmed front text.
import type { Bot } from "mineflayer";
import type { SqlBotData } from "../../bot-data/index.js";
import { recordOwnSign } from "../../bot-data/index.js";
import { Vec3 } from "vec3";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import { familyMembers, signBlockFor } from "../../world/item-families.js";
import { isReplaceableForPlacement } from "../../world/block-classification.js";
import { carriedCount, settleInventoryCount } from "../../world/inventory-count.js";
import { placeBlock, type InventoryItem, type WorldBlock } from "../../world/placement.js";
import { awaitOwnPlacement, forgetPlacement, recordPlacementSent, startOwnPlacement, type OwnPlacement } from "../../world/own-placement.js";
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
  readonly stop: AbortController;
  readonly lifetime: AbortSignal;
  answers?: SignAnswers;
  dispose?: () => void;
  block: string | null;
  consumption: { item: string; expected: number } | null;
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
  const confirmed = answers.text(run.lines, bot.time?.age, signal);
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
    onSent: () => {
      recordPlacementSent(run.own, [run.target], bot.time?.age);
      run.consumption = bot.game.gameMode === "creative" ? null : { item: plan.item.name, expected: carriedCount(bot, plan.item.name) - 1 };
      run.block = plan.block;
      run.phase = "sent";
    } });
  signal.throwIfAborted();
  const didPlace = run.own.cells.length > 0 && bot.blockAt(run.target)?.name === plan.block;
  if (placed.kind === "failed" && !didPlace) return refusal(run, placed.error);
  run.phase = "placed";
  return finishWriting(run, answers, signal);
}

/** A partial never spends another edit permission; T5c can reopen a known blank sign once. */
function unconfirmed(run: SignRun, cause: string): PlaceSignResult {
  recordPlacedSign(run);
  return { status: "partial", error: placeSignOutcomes.unconfirmed(run.block!, cause), sign: evidence(run, true) };
}

/** Share the original editor permission between placement and its resumed write. */
async function finishWriting(run: SignRun, answers: SignAnswers, signal: AbortSignal): Promise<PlaceSignResult> {
  let cause = "the server did not open the sign editor";
  if (await answers.editor(signal)) cause = await writeSign(run, answers, signal) ?? "";
  signal.throwIfAborted();
  if (cause) return unconfirmed(run, cause);
  recordPlacedSign(run);
  run.phase = "written";
  return { status: "succeeded", sign: evidence(run, true, true) };
}

/** Keep packet evidence during a reflex cut, but release it when the logical request ends. */
function signAnswers(run: SignRun): SignAnswers {
  if (run.answers) return run.answers;
  const { bot } = run.deps;
  const onEnd = () => { run.stop.abort(new Error("Disconnected while placing a sign")); run.dispose?.(); };
  const onDeath = () => { run.stop.abort(new Error("Died while placing a sign")); run.dispose?.(); };
  const onAbort = () => run.dispose?.();
  run.answers = watchSignAnswers(bot, run.target, AbortSignal.any([run.lifetime, run.stop.signal]));
  run.dispose = () => {
    run.answers?.dispose();
    delete run.answers;
    bot.removeListener("end", onEnd);
    bot.removeListener("death", onDeath);
    run.lifetime.removeEventListener("abort", onAbort);
    delete run.dispose;
  };
  bot.once("end", onEnd);
  bot.once("death", onDeath);
  run.lifetime.addEventListener("abort", onAbort, { once: true });
  return run.answers;
}

/** Settle the earlier packet before planning, and never credit an unsent sign or resend an edit. */
async function resumeSign(run: SignRun, signal: AbortSignal): Promise<PlaceSignResult | null> {
  const { bot } = run.deps;
  const seen = await awaitOwnPlacement(bot, run.own, (block) => block.name === run.block, signal);
  if (seen.kind === "none") return null;
  if (seen.kind === "unloaded") return refusal(run, placeSignOutcomes.unloaded);
  if (seen.kind === "not_landed") {
    forgetPlacement(run.own);
    run.phase = "approach";
    return null;
  }
  if (run.consumption) {
    await settleInventoryCount(bot, run.consumption.item, run.consumption.expected, {
      signal, ...(run.own.sentAtAge !== undefined && { sentAtAge: run.own.sentAtAge }),
    });
    signal.throwIfAborted();
  }
  const reading = readSignAt(bot, run.target);
  if ((run.phase === "written" || run.answers?.textConfirmed(run.lines)) && reading?.known && reading.front.every((line, index) => line === run.lines[index])) {
    run.phase = "written";
    recordPlacedSign(run);
    return { status: "succeeded", sign: evidence(run, true, true) };
  }
  if (reading?.known && [...reading.front, ...reading.back].some((line) => line !== "")) {
    return { ...refusal(run, placeSignOutcomes.taken(reading.block)), existing: { block: reading.block, front: reading.front } };
  }
  if (run.phase === "edit_sent" || run.phase === "written") return unconfirmed(run, "the previous edit has no matching text answer; read the sign before filling it");
  run.phase = "placed";
  return finishWriting(run, signAnswers(run), signal);
}

/** Scope waits to one attempt while packet observations belong to the whole request. */
async function executeSign(run: SignRun, context: ActionContext): Promise<PlaceSignResult> {
  const { bot, navigation } = run.deps;
  const signal = AbortSignal.any([run.lifetime, run.stop.signal, ...(context.signal ? [context.signal] : [])]);
  try {
    signal.throwIfAborted();
    const route = await raceSignal(approachTarget(bot, run.target, { signal }, { createMovements, navigate: navigation.navigate }), signal);
    if (route?.status === "stopped") return refusal(run, placeSignOutcomes.failed(route.reason));
    if (cellIntersectsPlayerBody(run.target, bot.entity.position)) return refusal(run, placeSignOutcomes.failed("The bot still occupies the sign cell"));
    const resumed = await resumeSign(run, signal);
    if (resumed) return resumed;
    const plan = planPlacement(run);
    if ("status" in plan) return plan;
    return await placeAndWrite(run, plan, signAnswers(run), signal);
  } finally {
    if (!context.signal?.aborted || run.lifetime.aborted || run.stop.signal.aborted) run.dispose?.();
  }
}

/** Construct the request-owned sign action. */
export function createPlaceSignAction(deps: PlaceSignDependencies) {
  return defineAction({ name: PLACE_SIGN, description: PLACE_SIGN_DESCRIPTION, inputSchema: placeSignInputSchema, resultSchema: placeSignResultSchema,
    checkpointSchema: placeSignCheckpointSchema, formatResult: (result) => JSON.stringify(result), annotations: placeSignAnnotations,
    execution: { kind: "resumable_task", prepare: (signal) => prepareBotForMovement(deps.bot, deps.navigation, signal) }, parse: parsePlaceSignRequest,
    begin(request, lifetime, observe) {
      const run: SignRun = { deps, request, target: new Vec3(request.x, request.y, request.z), lines: normalizeLines(request.lines), own: startOwnPlacement(), phase: "approach", block: null, consumption: null, stop: new AbortController(), lifetime };
      const target = { x: request.x, y: request.y, z: request.z };
      observe(() => ({ baseline: { target }, checkpoint: { mode: "place", phase: run.phase, target, sentAge: run.own.sentAtAge ?? null, clicked: false }, completion: { kind: "event", observed: run.phase === "written", owes: "server-confirmed front text" } }));
      return (context) => executeSign(run, context);
    } });
}
