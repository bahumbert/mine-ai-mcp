// Building a house from a template (build): the site, its protection and leveling, then the stages and the claim sign.
import type { Step } from "../actions.ts";
import { billOfMaterials, type MaterialCount } from "../building/blueprint.ts";
import { houseBox } from "../building/house-site.ts";
import { checkMaterials, shapesForMaterials } from "../building/materials.ts";
import { replacedHouseNote, siteRefusal } from "../building/new-site.ts";
import { builderStand, chooseSite, planTemplate, siteAt, type HousePlan } from "../building/plan.ts";
import { billFrom, buildAgain, callWorks, missingForStage, scaffoldNeed, scaffoldReserve, stageAt, stageCells, stageCellsNow, stagesBuilt } from "../building/stage-progress.ts";
import { classicTemplate, familiesOf, templateFor, templateOfKind, TEMPLATES, type Template } from "../building/templates.ts";
import { remadeClause } from "../building/tool-loss.ts";
import { describeWay } from "../gathering/fetch-farther.ts";
import { withMaterialsKept } from "../gathering/gather-materials.ts";
import { earlierProtections, newSiteNote } from "../protected-areas.ts";
import { billShortfall } from "../relations/items.ts";
import type { BotRuntime, Position } from "../runtime-client.ts";
import type { SkillContext, SkillResult, UnfinishedHouse } from "../skills.ts";
import { scaffoldReserveBetween, walkKeeping } from "../walks.ts";
import { ensureClaimSign, signToUse, type ClaimResult } from "./claim-sign.ts";
import { buildParts } from "./house-parts.ts";
import { distanceBetween, findPlayer } from "./positions.ts";
import { releaseArea } from "./protect-area.ts";
import { levelZone } from "./level-zone.ts";
import { noteArea } from "./protected-areas.ts";
import type { Cell } from "./structure-audit.ts";

/** An unfinished house is resumed only by a build step this close to its door; farther away a new one is started. */
export const RESUME_RANGE = 6;

/**
 * Builds a house from a template where the bot stands, facing the requester, with carried blocks only (the
 * model fetches them first with `get_items`); one `build_structure` call per batch. A house left unfinished (a cell
 * refused, the step set aside) is finished at the same site by the next build of the same kind.
 */
export async function build(context: SkillContext, step: Extract<Step, { skill: "build" }>): Promise<SkillResult> {
  const snapshot = await context.runtime.status();
  const templates = context.templates ?? TEMPLATES;
  // No template and no size: the persona's small house of its own style.
  const template = step.template === undefined ? classicTemplate(context.style, step.size ?? "small", templates) : templateFor(step.template, templates);
  if (template === undefined) return { status: "failed", detail: noTemplate(step.template, templates) };
  const what = `a ${template.kind}`;
  // The unfinished house is resumed where it stands; asked to build somewhere else, she starts a new one (live
  // 2026-10-02: "change of plan, build it right here" resumed the old pond-side site).
  // At given coordinates (its door), wherever she happens to stand (live 2026-10-02: asked for a house at a place,
  // she walked to a crafting table for the materials and built where the table was).
  const at = step.x !== undefined && step.y !== undefined && step.z !== undefined ? { x: step.x, y: step.y, z: step.z } : null;
  const unfinished = context.building?.unfinished;
  const resumed = resumable(unfinished, template, templates, at ?? snapshot.position);
  // Her own house has no asker to face or to name (an ordered house is the asker's unless the step says `own`).
  const own = resumed?.owner === undefined ? step.own === true || context.requester === undefined : resumed.owner === context.self;
  const toward = own || context.requester === undefined ? null : findPlayer(snapshot, context.requester)?.position ?? null;
  // A resumed house keeps the materials it was started with; the step's are ignored then.
  const materials = resumed === null ? step.materials ?? {} : resumed.materials ?? {};
  if (resumed === null && Object.keys(materials).length > 0) {
    const refusal = checkMaterials(materials, template, await context.runtime.blockKinds(Object.values(materials).filter((block) => block !== "air")));
    if (refusal !== null) return { status: "failed", detail: `cannot build ${what} with those materials: ${refusal}` };
  }
  const shapes = resumed === null ? shapesForMaterials(template, materials) : resumed.shapes ?? {};
  const plan = planTemplate(template, resumed?.site ?? (at === null ? chooseSite(snapshot.position, toward) : siteAt(at, toward)), materials, shapes);
  let replaced = "";
  if (resumed === null) {
    // A new site clear of every protected area before anything is protected or dug, and if not, where the nearest
    // clear one is (live 2026-10-03: told only "choose another zone clear of it", she stepped one block at a time,
    // and each refused start left its site protected for good: 16 house boxes, most of them never built).
    const areas = await context.runtime.protectedRegions();
    // What a new house here would leave untracked, said before anything is replaced (the old house's step is read first).
    const untracked = unfinished === null || unfinished === undefined ? "" : newSiteNote(unfinished, describeWay(plan.site.door, unfinished.site.door), context.templates);
    const refused = await siteRefusal(context, { template, plan, what, areas, unfinished, untracked, toward, from: snapshot.position });
    if (refused !== null) return refused;
    // Only what the first stage needs, named as the step that fetches it: get_items adds to what she carries, so asking
    // for the whole bill fetched it twice and filled her inventory (live 2026-10-02).
    // And what it needs to stand on, when some of its cells are out of reach of the ground (the whole bill is kept off the scaffold list while the house is built).
    const first = stageCells(plan, plan.stages[0]!);
    const { missing, owedNote } = billShortfall(await billWithSign(context.runtime, plan, billOfMaterials(first)), snapshot.inventory, context.owed?.() ?? []);
    const scaffold = scaffoldNeed(callWorks(plan, plan.stages[0]!, first), plan.site.door.y, snapshot.inventory, snapshot.policy?.scaffoldBlocks, plan.bill.map((entry) => entry.item));
    if (missing.length > 0 || scaffold !== null) return { status: "failed", detail: missingForStage(plan, 0, what, { missing, owedNote, scaffold }, { fresh: true, newSite: untracked }) };
    replaced = replacedHouseNote(context, unfinished, areas);
  }
  // The bill is not scaffolding while the house is built: the walks of the site's leveling used the very blocks it needs
  // (live 2026-10-04: 16 of 36 cobblestone); nor is the scaffold its cells out of reach need, on the walk to the site (live 2026-11-11).
  const startStage = resumed === null ? 0 : stageAt(plan, resumed.part);
  const remaining = billFrom(plan, plan.stages[startStage]!.first);
  if (at !== null) {
    const stand = builderStand(plan.site);
    context.progress?.(`walking to the site of ${what} at ${at.x} ${at.y} ${at.z}`);
    const bill = remaining.map((entry) => entry.item);
    const scaffold = await scaffoldReserveBetween(context, plan, { first: plan.stages[startStage]!.first, last: plan.stages.at(-1)!.last }, bill, resumed !== null);
    const there = await walkKeeping(context, stand, `Walk to the site of ${what}.`, { items: bill, reserve: [], scaffold }, remaining);
    if (context.signal.aborted) return { status: "stopped" };
    if (there.status !== "succeeded") return { status: "failed", detail: `could not reach the site of ${what} at ${at.x} ${at.y} ${at.z}: ${there.error ?? there.status}; ${buildAgain(plan)} tries again` };
  }
  const identity = resumed === null
    ? { ...(own ? context.self !== undefined && { owner: context.self } : { owner: context.requester }), dimension: snapshot.dimension }
    : { ...(resumed.owner !== undefined && { owner: resumed.owner }), ...(resumed.dimension !== undefined && { dimension: resumed.dimension }) };
  return withMaterialsKept(context.runtime, remaining.map((entry) => entry.item), () => buildOnSite(context, { own, resumed, plan, remaining, replaced, identity }));
}

/** The unfinished house `build` of `template` goes on with: its own template, with the bot (or the step's place) near its door or inside its house box. */
function resumable(unfinished: UnfinishedHouse | null | undefined, template: Template, templates: ReadonlyMap<string, Template>, from: Position): UnfinishedHouse | null {
  if (unfinished === null || unfinished === undefined) return null;
  if ((unfinished.template ?? templateOfKind(unfinished.kind, templates)?.id) !== template.id) return null;
  if (distanceBetween(from, unfinished.site.door) <= RESUME_RANGE) return unfinished;
  // A 30-wide house puts a bot standing in it far from its door.
  const { min, max } = houseBox(planTemplate(template, unfinished.site, unfinished.materials ?? {}, unfinished.shapes ?? {}).batches.flat());
  const inside = from.x >= min.x && from.x < max.x + 1 && from.z >= min.z && from.z < max.z + 1 && from.y >= min.y && from.y < max.y + 2;
  return inside ? unfinished : null;
}

/** Why `build` has no template to build: the id the step gave is unknown, or no classic file of her style and size exists. */
function noTemplate(id: string | undefined, templates: ReadonlyMap<string, Template>): string {
  const known = [...templates.keys()].sort().join(", ");
  return id === undefined
    ? `no small or medium house of your own style is known: build one of these with "template": ${known}`
    : `no house template "${id}": the ones you know are ${known} (families: ${familiesOf(templates).join(", ")})`;
}

/** `result` with `note` at the end of its detail, whichever way the step ends (the old record is replaced as soon as the new house starts). */
export function noted(result: SkillResult, note: string): SkillResult {
  return result.status === "stopped" ? result : { ...result, detail: `${result.detail}${note}` };
}

/** Add the selected sign to a fresh house's shortfall without crafting during construction; a house with no sign cell asks none. */
async function billWithSign(runtime: BotRuntime, plan: HousePlan, bill: readonly MaterialCount[]): Promise<readonly MaterialCount[]> {
  if (plan.sign === null) return bill;
  try {
    const sign = await signToUse(runtime, []);
    return sign === null || sign.carried ? bill : [...bill, { item: sign.item, count: 1 }];
  } catch {
    return bill;
  }
}

/** What {@link build} worked out before the house is protected and built. */
interface SitePlan {
  readonly own: boolean;
  readonly resumed: UnfinishedHouse | null;
  readonly plan: HousePlan;
  /** What the stages from the current one on still take: not scaffolding while the house is built. */
  readonly remaining: readonly MaterialCount[];
  /** Ends the result of a new house that replaced an unfinished one's record ("; your unfinished … is no longer tracked …"). */
  readonly replaced: string;
  readonly identity: Pick<UnfinishedHouse, "owner" | "dimension">;
}

/** The unfinished house's record, kept at once at every change (`leave`) or forgotten. */
interface HouseRecord {
  readonly leave: (part: number, prepared?: boolean, refused?: readonly Cell[]) => void;
  readonly forget: () => void;
}

/** Old notes without an owner or dimension cannot safely acquire an automatic claim. */
async function claimHouse(context: SkillContext, { plan, identity, what }: Pick<SitePlan, "plan" | "identity"> & { readonly what: string }, knownClaim?: ClaimResult["claim"]): Promise<ClaimResult | null> {
  if (plan.sign === null || identity.owner === undefined || identity.dimension === undefined) return null;
  try {
    return await ensureClaimSign(context, { spot: plan.sign, door: plan.site.door, owner: identity.owner, dimension: identity.dimension, what }, { craft: false, reserved: plan.bill, knownClaim });
  } catch (error) {
    return { status: context.signal.aborted ? "stopped" : "failed", detail: `${String(error)}; inspect the claim cell on the next visit.`, claim: null };
  }
}

/** Confirmed text needs no end-pass repair; every other result gets the planned final check. */
function claimWritten(claim: ClaimResult | null): boolean {
  return claim !== null && ["standing", "placed", "filled"].includes(claim.status);
}

/** Sign trouble describes the claim, without changing a successfully built house's result. */
function claimClause(claim: ClaimResult | null, owner: string | undefined): string {
  if (claim === null) return "";
  return claimWritten(claim) ? `; claim sign placed: ${owner}; ${claim.detail}` : `; no claim sign yet: ${claim.status}; ${claim.detail}`;
}

/** {@link build} from the protection of the site to the end. */
async function buildOnSite(context: SkillContext, sitePlan: SitePlan): Promise<SkillResult> {
  const { own, resumed, plan, remaining, replaced, identity } = sitePlan;
  const { template } = plan;
  const { kind } = template;
  const what = `a ${kind}`;
  // Protected before the first block and again on every resume (the runtime keeps one region per box): its own
  // gathering and goals must not dig into the house (ADR-012). The build itself still works inside it.
  const protection = await context.runtime.protectRegion({
    ...houseBox(plan.batches.flat()),
    label: kind,
    reason: `Keep my own digging out of the ${kind} I am building.`,
  });
  if (protection.status === "failed") return { status: "failed", detail: `could not protect the site of ${what}: ${protection.error}` };
  noteArea(context, protection.area);
  let claimRecord = resumed?.claim;
  // Every change of the record is saved at once: a call that throws skips the save after the step (run 17b).
  const record = (unfinished: UnfinishedHouse | null) => {
    if (context.building === undefined) return;
    context.building.unfinished = unfinished;
    context.saveBuilding?.();
  };
  const leaveUnfinished = (part: number, prepared = true, refused = resumed?.refused) => {
    const stage = stageAt(plan, part);
    record({
      kind, template: template.id, family: template.family, site: plan.site, part, prepared, materials: plan.materials,
      ...(Object.keys(plan.shapes).length > 0 && { shapes: plan.shapes }), ...identity, ...(claimRecord !== undefined && { claim: claimRecord }),
      stage, stages: plan.stages.length, stageName: plan.stages[stage]!.name,
      ...(refused !== undefined && refused.length > 0 && { refused }),
    });
  };
  const house: HouseRecord = { leave: leaveUnfinished, forget: () => record(null) };
  // A new house is on record before the first dig: its box is protected from now on, and a restart must find it.
  if (resumed === null) leaveUnfinished(0, false);
  if (resumed === null || resumed.prepared === false) {
    const unprepared = await prepareSite(context, { plan, what, house, remaining, regionId: protection.area.regionId });
    if (unprepared !== null) return noted(unprepared, replaced);
  }
  let claim = await claimHouse(context, { plan, identity, what }, claimRecord);
  claimRecord = claim?.claim ?? claimRecord;
  if (claim?.status === "stopped" || context.signal.aborted) {
    leaveUnfinished(resumed?.part ?? 0);
    return { status: "stopped" };
  }
  const remadeNotes: { readonly item: string; readonly note: string }[] = [];
  const keepAlways = plan.sign === null ? [] : [plan.sign.position, plan.sign.support, ...(claimRecord?.attach === "wall" || claim?.status === "unknown" || claim?.status === "taken" ? [plan.sign.wall] : [])];
  const stopped = await buildStages(context, { plan, what, resumed, house, remaining, remadeNotes, keepAlways });
  if (stopped !== null) return noted(stopped, `${stopped.status === "failed" ? claimClause(claim, identity.owner) : ""}${replaced}${remadeClause(remadeNotes)}`);
  if (!claimWritten(claim)) {
    claim = await claimHouse(context, { plan, identity, what }, claimRecord);
    claimRecord = claim?.claim ?? claimRecord;
    if (claim?.status === "stopped" || context.signal.aborted) {
      leaveUnfinished(plan.batches.length - 1);
      return { status: "stopped" };
    }
  }
  house.forget();
  const { door, facing } = plan.site;
  const roof = plan.roofTop;
  const memory = { door, facing, materials: plan.materials, ...(Object.keys(plan.shapes).length > 0 && { shapes: plan.shapes }), ...identity, ...(claimRecord !== undefined && { claim: claimRecord }) };
  context.remember?.({
    name: `the ${kind} you built${own ? "" : ` for ${identity.owner ?? context.requester}`}`,
    detail: `door ${door.x} ${door.y} ${door.z} facing ${facing}; stand on its roof at ${roof.x} ${roof.y} ${roof.z}`,
    ...(own && { own: true }),
    // A classic file is remembered by its size and style as before; any other template by its id and family.
    house: template.classic === undefined
      ? { template: template.id, family: template.family, ...memory }
      : { size: template.classic.size, style: template.classic.style, ...memory },
  });
  return { status: "done", detail: `built ${what}, door at ${door.x} ${door.y} ${door.z} facing ${facing}${claimClause(claim, identity.owner)}${replaced}${remadeClause(remadeNotes)}` };
}

/**
 * The site first, the first time only: everything above the floor in the house's box dug, holes under it filled, so
 * no part meets terrain, water or loose stone (live 2026-10-01/02). Null when it is ready (and on record as prepared),
 * else the result that ends the step.
 */
async function prepareSite(context: SkillContext, site: { plan: HousePlan; what: string; house: HouseRecord; remaining: readonly MaterialCount[]; regionId: number }): Promise<SkillResult | null> {
  const { plan, what, house, remaining, regionId } = site;
  const box = houseBox(plan.batches.flat());
  // Clearing and levelling the site is reshaping ground, not building (spec 2026-10-04-activity-time-travel-terraforming).
  context.phase?.("terraforming");
  const prepared = await levelZone(context, { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z }, plan.site.door.y, `the site of ${what}`, {
    // Blocks do not fall: a house needs its ring level and the water above its floor gone, not a pond filled under
    // it (live 2026-10-02: 258 cobblestone mined for a site over a pond). Its own floor goes in even over water.
    below: 1,
    placedLater: new Set(plan.batches.flat().filter((cell) => cell.block !== "air").map((cell) => `${cell.x},${cell.y},${cell.z}`)),
  }, remaining, [regionId, ...earlierProtections(context, plan.template.kind, plan.site.door, regionId, await context.runtime.protectedRegions())]);
  // Nothing of the house stands yet: its site is not kept protected (a resume protects it again).
  if (prepared.status === "stopped" || context.signal.aborted) {
    house.leave(0, false);
    await releaseArea(context, regionId);
    return { status: "stopped" };
  }
  if (prepared.status === "failed") {
    await releaseArea(context, regionId);
    // A site another protected area overlaps cannot be prepared later either: the unfinished house is forgotten, not
    // offered again and again (live 2026-10-07: Ayla's unfinished house overlapped her other house #12; she went
    // back to it, protected a "temp_house" over it, and tried again).
    if (/overlaps protected area/u.test(prepared.detail)) {
      house.forget();
      return { status: "failed", detail: `could not prepare the site of ${what}: ${prepared.detail}; that unfinished house is given up: build a new one somewhere clear` };
    }
    house.leave(0, false);
    return { status: "failed", detail: `could not prepare the site of ${what}: ${prepared.detail}; ${buildAgain(plan)} tries again` };
  }
  house.leave(0, true); // prepared, at once: a restart after this must never level again (it digs the house's walls too)
  context.phase?.("building");
  return null;
}

/**
 * The stages of the house, one after the other, each only when its blocks are carried: a stage whose blocks are not ends
 * the step (`done` when this step built a stage before it, `failed` when it built none), the record saying which stage is
 * next. A resumed house bills its current stage by the cells not yet right. Null once every stage is built and the
 * final check of all parts has passed. `keepAlways`: the claim cells, kept during every stage and the final check.
 */
async function buildStages(context: SkillContext, run: { plan: HousePlan; what: string; resumed: UnfinishedHouse | null; house: HouseRecord; remaining: readonly MaterialCount[]; remadeNotes: { readonly item: string; readonly note: string }[]; keepAlways: readonly Position[] }): Promise<SkillResult | null> {
  const { plan, what, resumed, house, remaining, remadeNotes, keepAlways } = run;
  const start = resumed === null ? 0 : stageAt(plan, resumed.part);
  const options = {
    reserved: remaining,
    remadeNotes,
    keepAlways,
    leave: (part: number, refused?: readonly Cell[]) => house.leave(part, true, refused),
    refusedBefore: resumed?.refused,
    again: context.building === undefined ? "" : `; ${buildAgain(plan)} resumes it`,
    abandon: house.forget,
  };
  for (let index = start; index < plan.stages.length; index += 1) {
    const stage = plan.stages[index]!;
    if (index > start) house.leave(stage.first);
    // The cells still to place are read once: the bill and the blocks to stand on both come from them, on a fresh status (the routes may have spent scaffold since the last stage).
    const cells = await stageCellsNow(plan, stage, index === start && resumed !== null ? context.runtime : null);
    const status = await context.runtime.status();
    const { missing, owedNote } = billShortfall(billOfMaterials(cells), status.inventory, context.owed?.() ?? []);
    const kept = remaining.map((entry) => entry.item), works = callWorks(plan, stage, cells);
    const scaffold = scaffoldNeed(works, plan.site.door.y, status.inventory, status.policy?.scaffoldBlocks, kept);
    if (missing.length > 0 || scaffold !== null) {
      const shortfall = { missing, owedNote, scaffold };
      return index === start
        ? { status: "failed", detail: missingForStage(plan, index, what, shortfall, { fresh: false }) }
        : { status: "done", detail: stagesBuilt(plan, start, index, shortfall) };
    }
    // A stage that stands on no scaffold of its own keeps the later stages' scaffold; one that needs its own uses what it has (its check was made alone).
    const reserve = scaffoldReserve(works, plan.site.door.y, status.policy?.scaffoldBlocks, kept).length > 0 || index === plan.stages.length - 1
      ? []
      : await scaffoldReserveBetween(context, plan, { first: plan.stages[index + 1]!.first, last: plan.stages.at(-1)!.last }, kept, false);
    const stopped = await buildParts(context, plan, what, { ...options, from: stage.first, to: stage.last, audit: false, reserve });
    if (stopped !== null) return stopped;
  }
  // The final check of every part: anything a later stage disturbed, or dug out since, is put back before the house counts as built.
  return buildParts(context, plan, what, { ...options, from: 0, to: -1 });
}
