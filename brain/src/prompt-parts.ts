// The work, goal and narrate tiers' user messages (and the chat situation block) as parts with shrink levels.
import type { MindTier } from "./brain-log.ts";
import { conditionLine } from "./condition.ts";
import { describeActivity } from "./activities.ts";
import { MAX_STEP_FAILURES, type ChatLine, type EarlierFailure, type GoalInput, type KnownPlace, type NarrateInput, type StepRecord, type WorkInput } from "./mind.ts";
import { describeOpportunities, drawnFirst, opportunityLine, type Opportunity } from "./opportunities.ts";
import { capLines, cut, HINTS, type PromptPart } from "./prompt-budget.ts";
import type { BotSnapshot, ProtectedArea } from "./runtime-client.ts";
import { describeTime } from "./time-spent.ts";

/**
 * The user message of the work, goal and narrate tiers (and the situation block of the chat tier) as parts with shrink
 * levels (spec 2026-11-06-p4-02a-prompt-budget, D2). Level 0 of every part is the text the tier always sent; the shrink
 * is by list length and characters only, never by item, block or word (Rule #0). The checks of `LlmMind` read the inputs,
 * never this text.
 */

/** The player inventory's main slots (hotbar included): a full inventory stops crafting and gathering. */
const INVENTORY_SLOTS = 36;
/** Steps of the current objective shown to the work tier: the latest ones are what it needs. */
const PROMPT_STEPS = 10;
/** The latest steps whose detail is never cut: the reason the model must follow is in the last ones. */
const WHOLE_DETAIL_STEPS = 2;

/** What each level keeps of a list: its first entry is level 0 (`Infinity`: all). */
const STEPS_SHOWN = [PROMPT_STEPS, 6, 3];
const STEP_DETAIL_CHARS = 160;
const FAILURES_NOT_REFUSED_SHOWN = [Infinity, 3, 1];
const FAILURE_DETAIL_CHARS = [Infinity, 300, 160];
const PLAYERS_SHOWN = [Infinity, 8, 3];
const AREAS_SHOWN = [10, 5, 2];
const PAUSED_SHOWN = [Infinity, 2, 1];
const LATELY_SHOWN = [Infinity, 3, 1];
const LATELY_LINE_CHARS = 300;
const HINT_LINES_SHOWN = [HINTS.lines, 4, 2];
const HISTORY_SHOWN = [Infinity, 6, 3];

/** Which parts shrink first, per tier (spec D2); a part absent from its tier's list is never shrunk. */
export const SHRINK_ORDER: Readonly<Record<MindTier, readonly string[]>> = {
  work: ["steps", "failures", "players", "areas", "paused"],
  goal: ["lately", "players", "areas", "hints"],
  chat: ["players", "areas", "history"],
  narrate: ["history"],
  sign: [],
};

/** The level's cap on a list (the last level's value for a level past the table). */
function shownAt(table: readonly number[], level: number): number {
  return table[Math.min(level, table.length - 1)] ?? Infinity;
}

/** "and N more" after the shown entries, when some were left out. */
function andMore(left: number, suffix = ""): string {
  return left > 0 ? `and ${left} more${suffix}` : "";
}

/** Whether `names` has `name`, ignoring case (player names are compared that way throughout the brain). */
function sameNameIn(names: readonly string[], name: string): boolean {
  return names.some((other) => other.toLowerCase() === name.toLowerCase());
}

// ---- the situation block --------------------------------------------------------------------------------------------

function distanceBetween(from: { readonly x: number; readonly y: number; readonly z: number }, to: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
}

function describePlayer(player: BotSnapshot["players"][number], from: BotSnapshot["position"]): string {
  if (player.position === null) return `${player.username} (far away)`;
  const { x, y, z } = player.position;
  return `${player.username} (${Math.round(distanceBetween(from, player.position))} blocks, at ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)})`;
}

/**
 * The players to show at a level: the nearest `shown` (a player out of sight counts as the farthest) and every name in
 * `keep`, in the snapshot's own order.
 */
function playersShown(snapshot: BotSnapshot, shown: number, keep: readonly string[]): BotSnapshot["players"] {
  const nearest = snapshot.players
    .map((player, index) => ({ index, distance: player.position === null ? Infinity : distanceBetween(snapshot.position, player.position) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, shown)
    .map((entry) => entry.index);
  return snapshot.players.filter((player, index) => nearest.includes(index) || sameNameIn(keep, player.username));
}

function playersPart(snapshot: BotSnapshot, keep: readonly string[]): PromptPart {
  const render = (level: number): string => {
    if (snapshot.players.length === 0) return "- Players online: none.";
    const shown = playersShown(snapshot, shownAt(PLAYERS_SHOWN, level), keep);
    const list = shown.map((player) => describePlayer(player, snapshot.position)).join(", ");
    const more = andMore(snapshot.players.length - shown.length);
    return `- Players online: ${more === "" ? list : `${list}, ${more}`}.`;
  };
  const label = (level: number) => `players: ${playersShown(snapshot, shownAt(PLAYERS_SHOWN, level), keep).length} of ${snapshot.players.length} shown (the nearest, and those named)`;
  return { key: "players", render, maxLevel: PLAYERS_SHOWN.length - 1, label, before: "\n" };
}

/** Distance from a point to the box of an area: 0 inside it. */
function distanceToArea(from: BotSnapshot["position"], area: ProtectedArea): number {
  const outside = (at: number, low: number, high: number) => Math.max(low - at, 0, at - high);
  return Math.hypot(outside(from.x, area.min.x, area.max.x), outside(from.y, area.min.y, area.max.y), outside(from.z, area.min.z, area.max.z));
}

/** The areas nearest first (the one she stands in first), ties by region id. */
function nearestAreasFirst(from: BotSnapshot["position"], areas: readonly ProtectedArea[]): ProtectedArea[] {
  return areas
    .map((area) => ({ area, distance: distanceToArea(from, area) }))
    .sort((a, b) => a.distance - b.distance || a.area.regionId - b.area.regionId)
    .map((entry) => entry.area);
}

function areasPart(snapshot: BotSnapshot, areas: readonly ProtectedArea[]): PromptPart {
  const ordered = nearestAreasFirst(snapshot.position, areas);
  const render = (level: number): string => {
    const shown = ordered.slice(0, shownAt(AREAS_SHOWN, level));
    const described = shown.map((area) => `#${area.regionId} ${area.label} (owner ${area.owner}, ${area.min.x} ${area.min.y} ${area.min.z} to ${area.max.x} ${area.max.y} ${area.max.z})`);
    const more = andMore(ordered.length - shown.length, ", farther away");
    const list = ordered.length === 0 ? "none" : [...described, ...(more === "" ? [] : [more])].join("; ");
    return `- Protected areas (you never dig or place blocks there): ${list}.`;
  };
  const label = (level: number) => `areas: nearest ${Math.min(ordered.length, shownAt(AREAS_SHOWN, level))} of ${ordered.length}`;
  return { key: "areas", render, maxLevel: AREAS_SHOWN.length - 1, label, before: "\n" };
}

/** Every item, stacks of the same item added up, and how full it is: a list cut short hid the junk she could drop (live 2026-10-02). */
function describeInventory(snapshot: BotSnapshot): string {
  if (snapshot.inventory.length === 0) return "empty";
  const totals = new Map<string, number>();
  for (const stack of snapshot.inventory) totals.set(stack.name, (totals.get(stack.name) ?? 0) + stack.count);
  return `${[...totals].map(([name, count]) => `${count} ${name}`).join(", ")} (${snapshot.inventory.length} of ${INVENTORY_SLOTS} slots used)`;
}

function fixedPart(key: string, text: string, before = "\n"): PromptPart {
  return { key, render: () => text, maxLevel: 0, before };
}

/**
 * The Situation block as parts: position, inventory, places and "doing" are never shrunk; players and areas are, and the
 * players named in `keepPlayers` (the requester, the speaker, those the message names) stay at every level.
 */
export function situationParts(snapshot: BotSnapshot, activity: string, places: readonly KnownPlace[], areas: readonly ProtectedArea[], keepPlayers: readonly string[]): PromptPart[] {
  const { x, y, z } = snapshot.position;
  return [
    fixedPart("position", `Situation:\n- Position ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}.`, "\n\n"),
    fixedPart("condition", conditionLine(snapshot, places)),
    fixedPart("inventory", `- Inventory: ${describeInventory(snapshot)}.`),
    playersPart(snapshot, keepPlayers),
    fixedPart("places", `- Places you know: ${places.length === 0 ? "none" : places.map((place) => `${place.name} (${place.detail})`).join("; ")}.`),
    areasPart(snapshot, areas),
    fixedPart("doing", `- Currently doing: ${activity}.`),
  ];
}

// ---- the chat history (chat and narrate tiers) ----------------------------------------------------------------------

/** "Recent chat": the latest lines, with whom each line spoke to as she read it then. */
export function historyPart(history: readonly ChatLine[]): PromptPart {
  const render = (level: number): string => {
    if (history.length === 0) return "Recent chat: (none)";
    // Whom each line spoke to, as she read it then ("unclear" says nothing, so it is left out).
    const to = (line: ChatLine) => line.to === undefined || line.to.length === 0 || line.to.includes("unclear") ? "" : ` to ${line.to.join(", ")}`;
    const shown = history.slice(-shownAt(HISTORY_SHOWN, level));
    return `Recent chat (with whom each line spoke to, as you read it then):\n${shown.map((line) => `${line.speaker}${to(line)}: ${JSON.stringify(line.text)}`).join("\n")}`;
  };
  const label = (level: number) => `history: last ${Math.min(history.length, shownAt(HISTORY_SHOWN, level))} of ${history.length}`;
  return { key: "history", render, maxLevel: HISTORY_SHOWN.length - 1, label };
}

// ---- the work tier --------------------------------------------------------------------------------------------------

function describeStepRecord(record: StepRecord, index: number): string {
  return `${index + 1}. ${record.step} -> ${record.outcome}: ${record.detail}`;
}

/** The latest steps, numbered within the shown slice; at a shrunk level the older details are cut, the last two never. */
function stepsPart(steps: readonly StepRecord[]): PromptPart {
  const recent = steps.slice(-PROMPT_STEPS);
  const shownAtLevel = (level: number) => recent.slice(-shownAt(STEPS_SHOWN, level));
  const render = (level: number): string => {
    if (recent.length === 0) return "Steps so far: none yet.";
    const shown = shownAtLevel(level);
    const lines = shown.map((record, index) => describeStepRecord(level > 0 && index < shown.length - WHOLE_DETAIL_STEPS ? { ...record, detail: cut(record.detail, STEP_DETAIL_CHARS) } : record, index));
    return `Steps so far, oldest first:\n${lines.join("\n")}`;
  };
  const label = (level: number) => {
    const shown = shownAtLevel(level).length;
    return `steps: last ${shown} of ${recent.length}${shown > WHOLE_DETAIL_STEPS ? `, older details cut to ${STEP_DETAIL_CHARS} characters` : ""}`;
  };
  return { key: "steps", render, maxLevel: STEPS_SHOWN.length - 1, label };
}

function describeEarlierFailure(failure: EarlierFailure, detailChars: number): string {
  const times = failure.count > 1 ? `failed ${failure.count} times, the last ` : "";
  const refused = failure.count >= MAX_STEP_FAILURES ? " (refused now)" : "";
  return `- ${failure.step}, ${times}${failure.minutesAgo} minute${failure.minutesAgo === 1 ? "" : "s"} ago${refused}: ${cut(failure.detail, detailChars)}`;
}

/** The failures to show at a level: every refused one, and the latest of the others (the list is most recent first). */
function failuresShown(failures: readonly EarlierFailure[], level: number): EarlierFailure[] {
  let others = 0;
  return failures.filter((failure) => {
    if (failure.count >= MAX_STEP_FAILURES) return true;
    others += 1;
    return others <= shownAt(FAILURES_NOT_REFUSED_SHOWN, level);
  });
}

/**
 * Facts before, not corrections after (ADR-017): what already failed for this objective, and why. Other objectives'
 * failures guard by key (rule 2) but are not shown (live 2026-10-11: Theo's junk-drop hint of his own goal buried an
 * order's materials); nor is one whose cause changed (the inventory or the place differs: "no boat is carried" stayed
 * in a prompt while Vex crafted 13 boats). A refused step stays in front of the model at every level: a hidden refusal
 * would be a step sent back again and again.
 */
function failuresPart(failures: readonly EarlierFailure[]): PromptPart {
  const render = (level: number): string => {
    if (failures.length === 0) return "";
    const lines = failuresShown(failures, level).map((failure) => describeEarlierFailure(failure, shownAt(FAILURE_DETAIL_CHARS, level)));
    return `Steps that failed lately in this objective (sent again as they are, they fail again; the reason says what to do instead; one that failed twice is refused):\n${lines.join("\n")}`;
  };
  const label = (level: number) => `failures: ${failuresShown(failures, level).length} of ${failures.length} lines, details cut to ${shownAt(FAILURE_DETAIL_CHARS, level)} characters`;
  return { key: "failures", render, maxLevel: FAILURES_NOT_REFUSED_SHOWN.length - 1, label };
}

function pausedPart(paused: WorkInput["paused"]): PromptPart {
  const render = (level: number): string => {
    if (paused.length === 0) return "";
    const shown = paused.slice(-shownAt(PAUSED_SHOWN, level));
    const more = andMore(paused.length - shown.length);
    return `Set aside until this one ends: ${[...shown.map((objective) => JSON.stringify(objective.text)), ...(more === "" ? [] : [more])].join("; ")}`;
  };
  const label = (level: number) => `paused: latest ${Math.min(paused.length, shownAt(PAUSED_SHOWN, level))} of ${paused.length}`;
  return { key: "paused", render, maxLevel: PAUSED_SHOWN.length - 1, label };
}

/**
 * A build refused for missing materials, when all of them are carried now: said, since the model did not see it (live
 * 2026-10-04: given everything a house lacked, Ayla went on looking for logs for 20 more steps and never built).
 */
function nowCarried(input: WorkInput): string {
  const refused = input.steps.findLast((record) => record.outcome === "failed" && /^missing .+ for .+ \(the rest is carried\)/u.test(record.detail));
  if (refused === undefined) return "";
  const [, list = "", what = ""] = /^missing (.+?) for (.+?) \(the rest is carried\)/u.exec(refused.detail) ?? [];
  const carried = new Map<string, number>();
  for (const stack of input.snapshot.inventory) carried.set(stack.name, (carried.get(stack.name) ?? 0) + stack.count);
  const needed = list.split(", ").map((part) => /^(\d+) ([a-z0-9_]+)$/u.exec(part.trim())).filter((match) => match !== null);
  if (needed.length === 0 || needed.some((match) => (carried.get(match[2]!) ?? 0) < Number(match[1]))) return "";
  return `Everything ${what} was missing (${list}) is carried now: build it again.`;
}

/** The work tier's user message as parts, in the order it has always had them. */
export function workParts(input: WorkInput): PromptPart[] {
  const { objective } = input;
  const whose = objective.requester === null ? "your own goal" : `asked by ${objective.requester}`;
  return [
    ...situationParts(input.snapshot, "working on this objective", input.places, input.areas, objective.requester === null ? [] : [objective.requester]),
    fixedPart("objective", `Objective (${whose}): ${JSON.stringify(objective.text)}`, "\n\n"),
    pausedPart(input.paused),
    stepsPart(input.steps),
    failuresPart((input.earlierFailures ?? []).filter((failure) => failure.objective === objective.text && !failure.changed)),
    fixedPart("carried", nowCarried(input), "\n\n"),
  ];
}

// ---- the goal tier --------------------------------------------------------------------------------------------------

/** The hints kept at a level, in their own order: whole lines until a cap, the first and the pressing ones always. */
function hintsKept(opportunities: readonly Opportunity[], level: number): Opportunity[] {
  const lines = opportunities.map(opportunityLine);
  const kept = capLines(lines, shownAt(HINT_LINES_SHOWN, level), HINTS.chars, (index) => opportunities[index]?.pressing === true);
  let next = 0;
  return opportunities.filter((_, index) => {
    if (lines[index] !== kept[next]) return false;
    next += 1;
    return true;
  });
}

function hintsPart(input: GoalInput): PromptPart {
  const render = (level: number): string =>
    `Things that could use doing, by what they are for: ${describeOpportunities(drawnFirst(hintsKept(input.opportunities, level), input.drawn))}`;
  const label = (level: number) => `hints: ${hintsKept(input.opportunities, level).length} of ${input.opportunities.length} lines`;
  return { key: "hints", render, maxLevel: HINT_LINES_SHOWN.length - 1, label };
}

function latelyPart(lately: readonly string[]): PromptPart {
  const render = (level: number): string => {
    if (lately.length === 0) return "Lately: nothing yet.";
    const shown = lately.slice(-shownAt(LATELY_SHOWN, level));
    return `Lately, oldest first:\n${shown.map((line) => `- ${level > 0 ? cut(line, LATELY_LINE_CHARS) : line}`).join("\n")}`;
  };
  const label = (level: number) => `lately: last ${Math.min(lately.length, shownAt(LATELY_SHOWN, level))} of ${lately.length}`;
  return { key: "lately", render, maxLevel: LATELY_SHOWN.length - 1, label };
}

/** The goal tier's user message as parts, in the order it has always had them. */
export function goalParts(input: GoalInput): PromptPart[] {
  return [
    ...situationParts(input.snapshot, "nothing", input.places, input.areas, []),
    fixedPart("drawn", input.drawn.length === 0 ? "" : `Right now you feel most like ${input.drawn.map(describeActivity).join(", or else ")}.`, "\n\n"),
    hintsPart(input),
    fixedPart("time", `How you spent the last hour: ${describeTime(input.time)}.`, "\n\n"),
    latelyPart(input.lately),
  ];
}

// ---- the narrate tier -----------------------------------------------------------------------------------------------

/** The narrate tier's user message as parts: the chat so far, what happened (`news`), and what to do about it (`tell`). */
export function narrateParts(input: NarrateInput, news: string, tell: string): PromptPart[] {
  return [historyPart(input.history), fixedPart("news", news, "\n\n"), fixedPart("tell", tell, "\n\n")];
}
