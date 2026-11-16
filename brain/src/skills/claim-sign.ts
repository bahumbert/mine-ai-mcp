// Claiming a house with a sign, without replacing any existing text.
import type { MaterialCount, SignSpot } from "../building/blueprint.ts";
import { sameDimension } from "../bot-data-sql.ts";
import type { ActOutcome } from "../body.ts";
import type { SignLinesInput } from "../mind.ts";
import { parsePlaceSign, type BotRuntime, type BotSnapshot, type Position, type SignReading } from "../runtime-client.ts";
import type { SkillContext } from "../skills.ts";
import { RESUME_RANGE } from "./build-house.ts";
import { distanceBetween } from "./positions.ts";
import { sameCell } from "./structure-audit.ts";

export interface HouseClaim {
  readonly spot: SignSpot;
  readonly owner: string;
  readonly what: string;
  readonly dimension: string;
  /** The house's resume anchor; older callers can supply only the sign spot. */
  readonly door?: Position;
}

export interface ClaimResult {
  readonly status: "standing" | "placed" | "filled" | "no_sign" | "taken" | "blank" | "unknown" | "stopped" | "failed";
  readonly detail: string;
  readonly claim: { readonly position: Position; readonly facing: SignSpot["facing"]; readonly attach: "ground" | "wall"; readonly placed: boolean } | null;
}

interface ClaimContext extends SkillContext {
  readonly signLines?: (input: Omit<SignLinesInput, "persona">, signal: AbortSignal) => Promise<string[]>;
}

interface ClaimOptions {
  readonly craft: boolean;
  readonly reserved: readonly MaterialCount[];
  readonly at?: Pick<BotSnapshot, "position" | "dimension" | "lastDeath">;
  readonly knownClaim?: ClaimResult["claim"];
}

type SignChoice = { item: string; carried: boolean };
type SuppliedSign = SignChoice & { readonly at?: BotSnapshot };
type ClaimAt = NonNullable<ClaimOptions["at"]>;
type Attachment = "ground" | "wall";

interface ClaimRun {
  readonly context: ClaimContext;
  readonly house: HouseClaim;
  readonly baseline: ClaimAt;
  record: ClaimResult["claim"];
}

/** A carried family member needs neither a recipe query nor a name convention. */
function carriedSign(inventory: BotSnapshot["inventory"]): SignChoice | null {
  const stack = inventory.find(({ count, families }) => count > 0 && families?.includes("sign"));
  return stack === undefined ? null : { item: stack.name, carried: true };
}

/** Reserve whole input kinds: crafting requirements do not report consumed quantities. */
function usesReserved(inputs: readonly string[] | undefined, reserved: readonly MaterialCount[]): boolean {
  return inputs === undefined || reserved.some(({ item, count }) => count > 0 && inputs.includes(item));
}

/** Select a ready recipe, retaining its missing inputs for the next-step message. */
async function readySign(runtime: BotRuntime, reserved: readonly MaterialCount[]): Promise<{ sign: SignChoice | null; detail: string }> {
  const members = await runtime.itemFamily("sign");
  const needs: string[] = [];
  for (const item of members) {
    const recipe = await runtime.craftingNeeds([{ item, count: 1 }]);
    if (recipe.status === "ready" && !usesReserved(recipe.inputs, reserved)) return { sign: { item, carried: false }, detail: "" };
    needs.push(...recipe.missing.map(({ item: input, count }) => `${count} ${input}`));
  }
  return { sign: null, detail: `Obtain a carried sign${members.length === 0 ? " from the sign item family" : ` (${members.join(", ")})`}, or crafting inputs not reserved for the house${needs.length === 0 ? "." : `: ${[...new Set(needs)].join(", ")}.`}` };
}

/** Choose an already carried sign, or a ready recipe using no reserved item. */
export async function signToUse(runtime: BotRuntime, reserved: readonly MaterialCount[]): Promise<SignChoice | null> {
  return carriedSign((await runtime.status()).inventory) ?? (await readySign(runtime, reserved)).sign;
}

/** Preserve an observed sign even when its text has not yet been confirmed. */
function rememberSign(run: ClaimRun, attach: Attachment): void {
  run.record = { position: run.house.spot.position, facing: run.house.spot.facing, attach, placed: true };
}

/** All outcomes carry the last observed claim, including cancellation after placement. */
function result(run: ClaimRun, status: ClaimResult["status"], detail: string): ClaimResult {
  return { status, detail, claim: run.record };
}

/** Test the lifetime and site again after every awaited boundary preceding an action. */
function canAct(run: ClaimRun, at: ClaimAt): boolean {
  return !run.context.signal.aborted && sameDimension(at.dimension, run.house.dimension)
    && at.lastDeath?.observedAt === run.baseline.lastDeath?.observedAt
    && distanceBetween(at.position, run.house.door ?? run.house.spot.position) <= RESUME_RANGE;
}

/** Unknown text always takes precedence over an apparently matching owner line. */
function signState(reading: SignReading, owner: string): "standing" | "blank" | "taken" | "unknown" {
  if (!reading.known) return "unknown";
  if (reading.front[0] === owner) return "standing";
  return [...reading.front, ...reading.back].every((line) => line === "") ? "blank" : "taken";
}

/** A failed model request leaves the mandatory owner line intact. */
async function claimLines(context: ClaimContext, house: HouseClaim): Promise<string[]> {
  try {
    return [house.owner, ...await context.signLines?.({ occasion: "claim", owner: house.owner, what: house.what }, context.signal) ?? []];
  } catch {
    return [house.owner];
  }
}

/** Fill calls use the same cell regardless of the existing sign's attachment. */
async function writeSign(run: ClaimRun, lines: readonly string[], attach: Attachment, item?: string, at?: BotSnapshot): Promise<ActOutcome | null> {
  if (!canAct(run, at ?? await run.context.runtime.status())) return null;
  const outcome = await run.context.body.act("place_sign", {
    ...run.house.spot.position, facing: run.house.spot.facing, attach, lines,
    ...(item === undefined ? { fill_blank: true } : { sign_item: item }),
  }, `Write the claim for ${run.house.owner}'s ${run.house.what}.`, { signal: run.context.signal });
  if (outcome.result !== undefined) {
    const evidence = parsePlaceSign(outcome.result).sign;
    if (evidence?.block !== null && evidence?.block !== undefined && evidence.placed) rememberSign(run, evidence.attach);
  }
  return outcome;
}

/** Map runtime refusals without guessing from message fragments. */
function signOutcome(run: ClaimRun, outcome: ActOutcome | null, filled: boolean): ClaimResult {
  if (outcome === null || run.context.signal.aborted || outcome.status === "cancelled") return result(run, "stopped", "Claim stopped; check the sign on the next visit.");
  const evidence = outcome.result === undefined ? undefined : parsePlaceSign(outcome.result).sign;
  if (outcome.status === "succeeded" && evidence?.confirmed) return result(run, filled ? "filled" : "placed", `Claim sign ${filled ? "filled" : "placed"}: ${evidence.lines.filter(Boolean).join(" / ")}`);
  if (outcome.code === "PLACE_SIGN_CELL_TAKEN") return result(run, "taken", "The claim cell is taken; keep its existing text or block.");
  if (outcome.code === "PLACE_SIGN_TEXT_UNKNOWN") return result(run, "unknown", "The sign text is unknown; read it on the next visit.");
  if (filled && (outcome.code === "PLACE_SIGN_TEXT_UNCONFIRMED" || outcome.code === "PLACE_SIGN_NO_EDITOR")) return result(run, "blank", "The sign's text is still unconfirmed; read it before trying a fill on the next visit.");
  return result(run, "failed", `${outcome.error ?? "Claim text was not confirmed"}; inspect the claim cell before trying again.`);
}

/** One fill per call; a failed fill is never followed by placement or another click. */
async function fillSign(run: ClaimRun, lines: readonly string[], attach: Attachment): Promise<ClaimResult> {
  return signOutcome(run, await writeSign(run, lines, attach), true);
}

/** Re-read an incomplete fresh placement, then fill only a sign known blank on both sides. */
async function recoverBlank(run: ClaimRun, lines: readonly string[], attach: Attachment): Promise<ClaimResult> {
  const observed = (await run.context.runtime.readSigns(run.house.spot.position))[0];
  if (run.context.signal.aborted) return result(run, "stopped", "Claim stopped; inspect the placed sign on the next visit.");
  if (observed === undefined) return result(run, "unknown", "The placed sign is not visible; move closer and read it again.");
  rememberSign(run, attach);
  const state = signState(observed, run.house.owner);
  if (state === "blank") return fillSign(run, lines, attach);
  return result(run, state === "standing" ? "taken" : state, "The sign was re-read; keep its text and inspect it on the next visit.");
}

/** Retry ground placement as a wall sign only when game geometry supplies a solid wall. */
async function placeClaim(run: ClaimRun, lines: readonly string[], item: string, at?: BotSnapshot): Promise<ClaimResult> {
  let attach: Attachment = "ground";
  let outcome = await writeSign(run, lines, attach, item, at);
  if (outcome?.code === "PLACE_SIGN_NO_SUPPORT" && !run.context.signal.aborted) {
    const { wall } = run.house.spot;
    const area = await run.context.runtime.blocksIn(wall, wall);
    const block = area.blocks.get(`${wall.x},${wall.y},${wall.z}`);
    if (block !== undefined && area.kinds[block]?.solid && area.kinds[block]?.fullCube === true) {
      attach = "wall";
      outcome = await writeSign(run, lines, attach, item);
    }
  }
  if (outcome?.code === "PLACE_SIGN_TEXT_UNCONFIRMED" && !run.context.signal.aborted) return recoverBlank(run, lines, attach);
  return signOutcome(run, outcome, false);
}

/** Recheck both the visit's lifetime and the selected recipe immediately before crafting. */
async function craftSign(run: ClaimRun, sign: SignChoice, reserved: readonly MaterialCount[]): Promise<ClaimResult | null> {
  const recipe = await run.context.runtime.craftingNeeds([{ item: sign.item, count: 1 }]);
  if (run.context.signal.aborted) return result(run, "stopped", "Claim stopped before crafting.");
  if (!canAct(run, await run.context.runtime.status())) return result(run, "stopped", "Claim stopped before crafting; return to the house before trying again.");
  if (recipe.status !== "ready" || usesReserved(recipe.inputs, reserved)) return result(run, "no_sign", `No sign ready: obtain ${sign.item} without using the house's reserved stock.`);
  const outcome = await run.context.body.act("craft_item", { items: [{ item_name: sign.item, count: 1 }] }, "Craft one claim sign from unreserved materials.", { signal: run.context.signal });
  if (run.context.signal.aborted || outcome.status === "cancelled") return result(run, "stopped", "Claim stopped after crafting; keep the sign for the next visit.");
  return outcome.status === "succeeded" ? null : result(run, "failed", `${outcome.error ?? "Crafting did not finish"}; obtain a carried sign before trying again.`);
}

/** Select from a current inventory; builds can only use an already carried sign. */
async function supplySign(run: ClaimRun, options: ClaimOptions): Promise<SuppliedSign | ClaimResult> {
  const snapshot = await run.context.runtime.status();
  if (!canAct(run, snapshot)) return result(run, "stopped", "Claim stopped; return to the house before trying again.");
  const carried = carriedSign(snapshot.inventory);
  if (carried !== null) return { ...carried, at: snapshot };
  if (!options.craft) return result(run, "no_sign", "No carried sign: obtain a sign from the sign item family before claiming this house.");
  const ready = await readySign(run.context.runtime, options.reserved);
  if (run.context.signal.aborted) return result(run, "stopped", "Claim stopped before crafting.");
  if (ready.sign === null) return result(run, "no_sign", ready.detail);
  return await craftSign(run, ready.sign, options.reserved) ?? ready.sign;
}

/** No sign reading does not mean empty: preserve every observed non-air block. */
async function checkClaimCell(run: ClaimRun): Promise<ClaimResult | null> {
  const [cell] = await run.context.runtime.cellsAt([run.house.spot.position]);
  if (run.context.signal.aborted) return result(run, "stopped", "Claim stopped while checking its cell.");
  if (cell?.loaded !== true) return result(run, "failed", "The claim cell is not loaded; move closer and read it again.");
  const kinds = await run.context.runtime.blockKinds([cell.name]);
  if (run.context.signal.aborted) return result(run, "stopped", "Claim stopped while checking its cell.");
  const tags = kinds[cell.name]?.tags;
  if (tags === undefined) return result(run, "unknown", "The claim cell's kind is unknown; inspect it before claiming.");
  return tags.includes("air") ? null : result(run, "taken", `The claim cell holds ${cell.name}; keep it and choose another claim spot.`);
}

/** Continue from the initial observation without touching signs that already have text. */
async function claimFromReading(run: ClaimRun, options: ClaimOptions): Promise<ClaimResult> {
  const reading = (await run.context.runtime.readSigns(run.house.spot.position))[0];
  if (run.context.signal.aborted) return result(run, "stopped", "Claim stopped after the read.");
  const state = reading === undefined ? null : signState(reading, run.house.owner);
  if (reading !== undefined && (state === "standing" || state === "blank")) {
    const attach = run.record?.attach ?? await observedAttachment(run.context.runtime, reading);
    if (run.context.signal.aborted) return result(run, "stopped", "Claim stopped while checking its attachment.");
    if (attach === null) return result(run, "unknown", "The sign's attachment is unknown; inspect its support before claiming.");
    rememberSign(run, attach);
  }
  if (state !== null && state !== "blank") return result(run, state, state === "standing" ? "The owner's claim is standing; keep its text." : "Keep the sign as it is; read it on the next visit before claiming.");
  if (state === null) {
    const occupied = await checkClaimCell(run);
    if (occupied !== null) return occupied;
  }
  const lines = await claimLines(run.context, run.house);
  if (run.context.signal.aborted) return result(run, "stopped", "Claim stopped after choosing its lines.");
  if (state === "blank") return fillSign(run, lines, run.record!.attach);
  const supplied = await supplySign(run, options);
  return "status" in supplied ? supplied : placeClaim(run, lines, supplied.item, supplied.at);
}

/** Shipped block tags identify attachment without guessing from a block's name. */
async function observedAttachment(runtime: BotRuntime, reading: SignReading): Promise<Attachment | null> {
  const tags = (await runtime.blockKinds([reading.block]))[reading.block]?.tags ?? [];
  return tags.includes("wall_signs") ? "wall" : tags.includes("standing_signs") ? "ground" : null;
}

/** Read, then place or fill one claim sign through the foreground body. */
export async function ensureClaimSign(context: ClaimContext, house: HouseClaim, options: ClaimOptions): Promise<ClaimResult> {
  let run: ClaimRun | undefined;
  try {
    if (context.signal.aborted) return { status: "stopped", detail: "Claim stopped before the read.", claim: null };
    const baseline = options.at ?? await context.runtime.status();
    run = { context, house, baseline, record: options.knownClaim?.placed && sameCell(options.knownClaim.position, house.spot.position) ? options.knownClaim : null };
    if (!canAct(run, baseline)) return result(run, "stopped", "Claim stopped; return to this house in its dimension before trying again.");
    return await claimFromReading(run, options);
  } catch (error) {
    return { status: context.signal.aborted ? "stopped" : "failed", detail: `${String(error)}; inspect the claim cell on the next visit.`, claim: run?.record ?? null };
  }
}
