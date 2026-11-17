// What a situation event shows the model (spec D5): the facts, the Weigh line and the options, all from the snapshot and the stack.
import { sameDimension } from "../bot-data-sql.ts";
import { nearestOwnHome, oneLine } from "../condition.ts";
import type { SkillName } from "../actions.ts";
import type { KnownPlace, Objective } from "../mind.ts";
import { BOLDNESS, type Boldness } from "../persona.ts";
import { WALK_BLOCKS_PER_SECOND } from "../shelter/spot.ts";
import { cut } from "../prompt-budget.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { BEDTIME_START_TICK, RECOVERY_MINUTES, TICKS_PER_MINUTE, coordinates, type SituationInfo } from "./situations.ts";

// The measured median shelter time rounded up to five seconds (plan 2026-11-17-p4-18-night-options-a4).
export const HOME_CLOSE_WALK_SECONDS = 15;
export const HOME_CLOSE_BLOCKS = HOME_CLOSE_WALK_SECONDS * WALK_BLOCKS_PER_SECOND;
// Owner's high and somewhat-enough boldness, and high gear score (plan 2026-11-17-p4-18-night-options-a4).
export const FAR_HOME_BOLDNESS: Boldness = "bold";
export const NO_DIG_BOLDNESS: Boldness = "steady";
export const NO_DIG_SCORE = 1.2;

const round2 = (value: number): number => Math.round(value * 100) / 100;
export const boldnessLevel = (boldness: Boldness): number => BOLDNESS.indexOf(boldness) + 1;
export const nightScore = (boldness: Boldness, snapshot: BotSnapshot): number => round2(boldnessLevel(boldness) * (1 - (snapshot.combat?.exposure ?? 1)));

export interface SituationOption {
  readonly label: string;
  /** One JSON object as text: the step the model answers with. */
  readonly form: string;
}

export interface SituationView {
  readonly facts: readonly string[];
  /** Exactly three: boldness, gear, whose work. */
  readonly weigh: readonly string[];
  readonly options: readonly SituationOption[];
  /** Explanations for the journal and monitor only, never the prompt. */
  readonly hidden: readonly string[];
}

export interface SituationViewInput {
  readonly info: SituationInfo;
  readonly snapshot: BotSnapshot;
  readonly places: readonly KnownPlace[];
  /** The work running or set aside, null when none. */
  readonly objective: Objective | null;
  /** A pushed situation's later call: option 1 leaves the event. */
  readonly pushed: boolean;
  readonly skills: readonly SkillName[];
  readonly boldness: Boldness;
  /** The top ordinary work's objective (situations skipped): whose work. */
  readonly ordinary: Objective | null;
  readonly deaths: { readonly total: number; readonly atNight: number };
  /** Night holds in the overworld (`SituationWatch.nightActive()`). */
  readonly night: boolean;
  readonly timeOfDay: number | null;
}

/** The step object as the model writes it: one key, its JSON text. */
function step(value: Record<string, string | number>): string {
  return JSON.stringify(value);
}

/** A walk to a block, rounded down as the runtime's block convention reads it. */
function goTo(at: Position): string {
  return step({ skill: "go_to", x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) });
}

/** The gear the snapshot reports, each part only when known (spec D5 "The Weigh line"), then the risk the gear leaves. */
export function gearFact(snapshot: BotSnapshot): string {
  const parts = [...armourParts(snapshot), ...combatParts(snapshot.combat)];
  return parts.length === 0 ? "gear: unknown" : `gear: ${parts.join(", ")}${riskPart(snapshot)}`;
}

/** The runtime's gear exposure (1 = no gear) as the risk a fight keeps, in percent (spec D2); "" when the runtime sends none. */
function riskPart(snapshot: BotSnapshot): string {
  const exposure = snapshot.combat?.exposure;
  return exposure === undefined ? "" : `; risk with this gear ${Math.round(100 * exposure)}% (100% = no gear)`;
}

/** Null points mean a piece is worn and the server reported no points (view_status contract, `armour`). */
function armourParts(snapshot: BotSnapshot): string[] {
  const points = snapshot.armourPoints;
  if (points === undefined) return [];
  const toughness = (snapshot.armourToughness ?? 0) > 0 ? `, toughness ${snapshot.armourToughness}` : "";
  return [points === null ? `armour worn, points unknown${toughness}` : `armour ${points} points${toughness}`];
}

function combatParts(combat: BotSnapshot["combat"]): string[] {
  if (combat === undefined) return [];
  const parts = [combat.melee === null ? "bare hands" : `melee ${combat.melee}`];
  if (combat.bow !== null) parts.push(combat.arrows > 0 ? `${combat.bow} with ${combat.arrows} arrows` : `${combat.bow}, no arrows`);
  if (combat.shield !== null) parts.push(combat.shield);
  return parts;
}

/** Whose work the ordinary stack holds: an order's requester, the bot's own goal, or nothing. */
function whoseWork(ordinary: Objective | null): string {
  if (ordinary === null) return "no work";
  return ordinary.requester === null ? "your own goal" : `order from ${ordinary.requester}`;
}

/** Only an own house with a door record counts (spec D5); outside the overworld it is still in the overworld. */
function homeFacts(places: readonly KnownPlace[], snapshot: BotSnapshot): string[] {
  const home = nearestOwnHome(places, snapshot);
  if (home === null) return ["you know no home of yours"];
  if (!sameDimension(snapshot.dimension, "overworld")) return ["your home is in the overworld"];
  return [`your home ${JSON.stringify(cut(oneLine(home.name), 120))} is ${Math.round(home.distance)} blocks away (door at ${coordinates(home.door)})`];
}

function deathsFact(deaths: { readonly total: number; readonly atNight: number }): string {
  return `you died ${deaths.total} times since you woke, ${deaths.atNight} of them at night`;
}

/** Hunger facts: only at low health, where a missed heal or a sprint matters (minecraft.wiki "Hunger", unverified here). */
function hungerFacts(food: number): string[] {
  const facts: string[] = [];
  if (food < 18) facts.push(`food ${food}/20: you do not heal by yourself`);
  if (food <= 6) facts.push(`food ${food}/20: you cannot sprint`);
  return facts;
}

/** Where the last death's things are, from the fresh snapshot (spec D5 respawn facts). */
function deathFacts(snapshot: BotSnapshot): string[] {
  const died = snapshot.lastDeath;
  if (died == null) return [];
  const facts: string[] = [];
  if (!sameDimension(died.dimension, snapshot.dimension)) facts.push(`your things are in ${died.dimension}`);
  if (died.minutesAgo >= RECOVERY_MINUTES) facts.push(`your things at ${coordinates(died.position)}: pick_up no longer takes them (over ${RECOVERY_MINUTES} min)`);
  return facts;
}

/** Beds work from the bedtime tick; before it, the fact says how long to wait. */
function bedsFact(timeOfDay: number): string {
  return `beds work in ${((BEDTIME_START_TICK - timeOfDay) / TICKS_PER_MINUTE).toFixed(1)} min`;
}

function hasBed(snapshot: BotSnapshot): boolean {
  return snapshot.inventory.some((stack) => stack.families?.includes("bed") === true) || snapshot.respawn?.kind === "bed";
}

/** The most filling carried food, or null when none is carried. */
function mostFilling(snapshot: BotSnapshot): { readonly name: string } | null {
  let best: { readonly name: string; readonly points: number } | null = null;
  for (const food of snapshot.foods) if (best === null || food.points > best.points) best = food;
  return best;
}

/** Option 1: carry on (or go back to own goals, or leave a pushed event); an order's requester hears the answer. */
function carryOnOption(input: SituationViewInput, hearing: string): SituationOption {
  const label = input.pushed ? "leave this event" : input.objective === null ? "go back to your own goals" : `carry on with ${JSON.stringify(cut(oneLine(input.objective.text), 120))}`;
  return { label: `${label}${hearing}`, form: step({ done: "carry on" }) };
}

function options(input: SituationViewInput, hearing: string): { options: SituationOption[]; hidden: string[] } {
  const { info, snapshot, places, skills, night, timeOfDay } = input;
  const has = (skill: SkillName): boolean => skills.includes(skill);
  const result: SituationOption[] = [carryOnOption(input, hearing)];
  const hidden: string[] = [];
  const home = nearestOwnHome(places, snapshot);
  const nightEvent = night && info.kind !== "low_health";
  const availableHome = home !== null && has("go_to") && sameDimension(snapshot.dimension, "overworld") ? home : null;
  const distance = availableHome === null ? null : Math.round(availableHome.distance);
  const close = distance !== null && distance <= HOME_CLOSE_BLOCKS;
  if (availableHome !== null) {
    if (nightEvent && !close && boldnessLevel(input.boldness) < boldnessLevel(FAR_HOME_BOLDNESS)) hidden.push(`go home: home ${distance} blocks away (over ${HOME_CLOSE_BLOCKS}) and boldness ${input.boldness} (${FAR_HOME_BOLDNESS} needed)`);
    else result.push({ label: "go home", form: goTo(availableHome.door) });
  }
  if (nightEvent && timeOfDay !== null && timeOfDay >= BEDTIME_START_TICK && hasBed(snapshot) && has("sleep")) result.push({ label: "sleep", form: step({ skill: "sleep" }) });
  if (nightEvent && has("dig_shelter")) {
    const score = nightScore(input.boldness, snapshot);
    if (close) hidden.push(`dig an emergency shelter here: home ${distance} blocks away (close: ${HOME_CLOSE_BLOCKS} or less)`);
    else if (boldnessLevel(input.boldness) >= boldnessLevel(NO_DIG_BOLDNESS) && score >= NO_DIG_SCORE) hidden.push(`dig an emergency shelter here: boldness ${input.boldness} x gear ${round2(1 - (snapshot.combat?.exposure ?? 1))} = ${score} (${NO_DIG_SCORE} or more)`);
    else result.push({ label: "dig an emergency shelter here", form: step({ skill: "dig_shelter" }) });
  }
  const died = snapshot.lastDeath;
  if (info.kind === "respawn" && died != null && has("go_to") && sameDimension(died.dimension, snapshot.dimension) && died.minutesAgo < RECOVERY_MINUTES) {
    result.push({ label: "go back for your things", form: goTo(died.position) });
  }
  const food = info.kind === "low_health" && snapshot.food < 20 && has("eat") ? mostFilling(snapshot) : null;
  if (food !== null) result.push({ label: "eat", form: step({ skill: "eat", food: food.name }) });
  return { options: result, hidden };
}

/** The facts, the Weigh line and the options of one event, as the work tier's prompt part shows them (spec D5). */
export function situationView(input: SituationViewInput): SituationView {
  const { info, snapshot, deaths, night, timeOfDay } = input;
  const facts = [
    ...homeFacts(input.places, snapshot),
    ...(deaths.total > 0 ? [deathsFact(deaths)] : []),
    ...(info.kind === "low_health" ? hungerFacts(snapshot.food) : []),
    ...(info.kind === "respawn" ? deathFacts(snapshot) : []),
    ...(night && info.kind !== "low_health" && timeOfDay !== null && timeOfDay < BEDTIME_START_TICK ? [bedsFact(timeOfDay)] : []),
  ];
  const weigh = [`boldness ${input.boldness} (cautious, steady or bold)`, gearFact(snapshot), whoseWork(input.ordinary)];
  const hearing = input.ordinary?.requester ? ` (${input.ordinary.requester} hears what you decide)` : "";
  return { facts, weigh, ...options(input, hearing) };
}
