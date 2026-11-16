import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { MindTier } from "./brain-log.ts";
import { chatParts, chatSystemPrompt, goalSystemPrompt, narrateSystemPrompt, personaPrompt, workSystemPrompt } from "./llm-mind.ts";
import { ACTIVITIES } from "./activities.ts";
import type { ChatInput, GoalInput, KnownPlace, Objective, WorkInput } from "./mind.ts";
import { HINTS, PROMPT_BUDGET, fitPrompt, reservedTokens, type PromptPart } from "./prompt-budget.ts";
import { goalParts, narrateParts, SHRINK_ORDER, situationEventPart, workParts } from "./prompt-parts.ts";
import { area, chatP50, chatWorst, goalP50, goalWorst, hints, narrateWorst, players, snapshotWith, workLarge, workP50, workWorst } from "./prompt-fixtures.ts";
import { SKILL_NAMES } from "./actions.ts";
import { situationView } from "./agent/situation-options.ts";
import type { SituationInfo } from "./agent/situations.ts";
import type { BotSnapshot } from "./runtime-client.ts";

const golden = (name: string) => readFileSync(new URL(`./fixtures/prompts-before/${name}.txt`, import.meta.url), "utf8").replace(/\r?\n$/u, "");
const part = (parts: readonly PromptPart[], key: string): PromptPart => {
  const found = parts.find((candidate) => candidate.key === key);
  assert.ok(found, `part ${key}`);
  return found;
};
const unlimited = (parts: readonly PromptPart[], tier: MindTier) => fitPrompt("", parts, SHRINK_ORDER[tier], Number.POSITIVE_INFINITY, 3.4);

test("level 0 is today's text: every fixture fitted with no limit equals its golden file, nothing shrunk", () => {
  const cases: [string, readonly PromptPart[], MindTier][] = [
    ["work-p50", workParts(workP50()), "work"],
    ["work-large", workParts(workLarge()), "work"],
    ["goal-p50", goalParts(goalP50()), "goal"],
    ["chat-p50", chatParts(chatP50(), true), "chat"],
  ];
  for (const [name, parts, tier] of cases) {
    const fitted = unlimited(parts, tier);
    assert.equal(fitted.text, golden(name), name);
    assert.deepEqual(fitted.shrunk, [], name);
  }
  // The median prompts fit the real budget as they are.
  for (const [name, parts, tier] of cases.filter(([name]) => name.endsWith("p50"))) {
    const fitted = fitPrompt("", parts, SHRINK_ORDER[tier], PROMPT_BUDGET[tier], 3.4);
    assert.equal(fitted.text, golden(name), name);
    assert.deepEqual(fitted.shrunk, [], name);
  }
});

test("the worst case of every tier fits its budget with the room still reserved", () => {
  // The ledger (spec D1): a feature that adds a line claims its room by adding the line as a part here (in the worst-case
  // fixture of `prompt-fixtures.ts`), deleting its row of RESERVED in `prompt-budget.ts`, and keeping this test green; one
  // that needs more changes PROMPT_BUDGET in its own commit.
  const work = workWorst();
  const goal = goalWorst();
  const chat = chatWorst();
  const narrate = narrateWorst();
  for (const persona of [work.persona, goal.persona, chat.persona, narrate.persona]) assert.ok(personaPrompt(persona).length >= 1800);
  const cases: [MindTier, string, readonly PromptPart[]][] = [
    ["chat", chatSystemPrompt(chat.persona, true), chatParts(chat, true)],
    ["work", workSystemPrompt(work.persona, work.ownsTemporaryHouse === true), workParts(work)],
    ["goal", goalSystemPrompt(goal.persona, ACTIVITIES), goalParts(goal)],
    ["narrate", narrateSystemPrompt(narrate.persona), narrateParts(narrate, "news", "tell")],
  ];
  for (const [tier, system, parts] of cases) {
    const fitted = fitPrompt(system, parts, SHRINK_ORDER[tier], PROMPT_BUDGET[tier] - reservedTokens(tier), 3.4);
    assert.equal(fitted.overBudget, false, `${tier}: ${fitted.estimated} tokens estimated, shrunk ${fitted.shrunk.join(" | ")}`);
  }
});

test("the condition line is never shrunk", () => {
  for (const [tier, parts] of [["work", workParts(workWorst())], ["goal", goalParts(goalWorst())], ["chat", chatParts(chatWorst(), true)]] as const) {
    const condition = part(parts, "condition");
    assert.equal(condition.maxLevel, 0);
    const text = fitPrompt("", parts, SHRINK_ORDER[tier], 1, 3.4).text;
    assert.ok(text.includes(`- Position 0 64 0.\n${condition.render(0)}\n- Inventory:`));
  }
});

test("the latest two steps keep their whole detail at every level", () => {
  const input = workWorst();
  const steps = part(workParts(input), "steps");
  assert.equal(steps.maxLevel, 2);
  const [secondLast, last] = input.steps.slice(-2);
  for (const level of [0, 1, 2]) {
    const text = steps.render(level);
    assert.ok(text.includes(last!.detail) && text.includes(secondLast!.detail), `level ${level}`);
  }
  // Level 1: the last 6, numbered from 1 within the slice; an older detail is cut and ends with an ellipsis.
  const level1 = steps.render(1).split("\n");
  assert.equal(level1.filter((line) => /^\d+\. /u.test(line)).length, 6);
  assert.match(level1[1]!, /^1\. get 5 oak_log -> done: .{150,160}…$/u);
  assert.match(steps.render(2), /^Steps so far, oldest first:\n1\. get 8 oak_log -> .*…\n2\. /u);
  assert.equal(steps.render(2).split("\n").filter((line) => /^\d+\. /u.test(line)).length, 3);
});

test("a refused step stays listed at every level", () => {
  const input = workWorst();
  const list = part(workParts(input), "failures");
  for (const level of [0, 1, 2]) {
    const text = list.render(level);
    assert.equal(text.split("\n").filter((line) => line.includes("(refused now)")).length, 2, `level ${level}`);
  }
  const lines = (level: number) => list.render(level).split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines(0).length, 8);
  assert.equal(lines(1).length, 2 + 3);
  assert.equal(lines(2).length, 2 + 1);
  // The latest of the others stay (the list is most recent first), their details cut to 160 characters.
  assert.ok(lines(2).some((line) => line.includes("craft 3 cooked_beef")));
  assert.ok(lines(2).every((line) => line.length < 260));
});

test("areas are nearest first, the one she stands in first, 10 at most", () => {
  const input = workP50();
  // 30 areas along x from 5 on, the bot stands at 0 64 0; areas 17 and 31 both contain it (distance 0): ties by regionId.
  const areas = Array.from({ length: 30 }, (_, index) => (index + 1 === 17 ? area(17, -3, 8) : area(index + 1, 5 + index * 10, 4)));
  areas.push(area(31, -2, 6));
  const text = part(workParts({ ...input, areas }), "areas").render(0);
  const shown = [...text.matchAll(/#(\d+) /gu)].map((match) => Number(match[1]));
  assert.equal(shown.length, 10);
  assert.deepEqual(shown.slice(0, 2), [17, 31], "inside first, ties by regionId");
  assert.deepEqual(shown.slice(2), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(text, /; and 21 more, farther away\.$/u);
});

test("the speaker, the requester and named players stay when players shrink", () => {
  const crowd = snapshotWith([], players(20));
  // Work: Player4 asked (the 4th nearest); level 2 shows the nearest 3 and the requester, then how many more.
  // The requester's name is matched whatever its case.
  const work = part(workParts({ ...workP50(), snapshot: crowd, objective: { text: "x", requester: "PLAYER4", purpose: null } }), "players");
  const level2 = work.render(2);
  for (const name of ["Player1", "Player2", "Player3", "Player4"]) assert.ok(level2.includes(`${name} (`), name);
  assert.match(level2, /, and 16 more\.$/u);
  const level1 = work.render(1);
  assert.match(level1, /, and 12 more\.$/u);
  // Far-away players (no position) count as the farthest: Player7 has none and is not among the nearest.
  assert.ok(!work.render(1).includes("Player7"));
  // Chat: the speaker (Player9) and a player the message names (Player12) stay with the nearest 3.
  const input: ChatInput = { ...chatP50(), snapshot: crowd, message: { username: "player9", channel: "chat", message: "Ayla, ask Player12 to come", addressed: true }, history: [] };
  const chat = part(chatParts(input, true), "players").render(2);
  for (const name of ["Player1", "Player2", "Player3", "Player9", "Player12"]) assert.ok(chat.includes(`${name} (`), name);
  assert.ok(!chat.includes("Player4 ("));
  assert.match(chat, /, and 15 more\.$/u);
  // Level 0 lists everyone, as today.
  assert.ok(!work.render(0).includes("more"));
});

test("inventory, places, objective, new message and About this message are never shrunk", () => {
  const checks: [MindTier, readonly PromptPart[], string[]][] = [
    ["work", workParts(workWorst()), ["Inventory: ", "Places you know: ", "Objective (an event)"]],
    ["chat", chatParts(chatWorst(), true), ["Inventory: ", "Places you know: ", "New message: Player2 says in chat, naming you"]],
    ["goal", goalParts(goalWorst()), ["Inventory: ", "Places you know: ", "How you spent the last hour"]],
  ];
  for (const [tier, parts, kept] of checks) {
    const fitted = fitPrompt("", parts, SHRINK_ORDER[tier], 1, 3.4);
    assert.equal(fitted.overBudget, true);
    for (const text of kept) assert.ok(fitted.text.includes(text), `${tier}: ${text}`);
  }
  const everyone = chatWorst();
  const conversation = part(chatParts({ ...everyone, message: { ...everyone.message, addressed: false } }, true), "conversation");
  assert.equal(conversation.maxLevel, 0);
  assert.match(conversation.render(0), /^About this message:/u);
  const worst = workWorst();
  const inventory = part(workParts(worst), "inventory");
  assert.equal(inventory.maxLevel, 0);
  assert.ok(inventory.render(0).includes("item_number_36"));
});

test("the hint part keeps pressing lines when it shrinks: level 0 keeps 6 lines up to 1600 characters, level 2 the pressing ones", () => {
  // Pressing hints come first, as findOpportunities returns them; a farming draw shows the farming ones before the others.
  const input: GoalInput = { ...goalP50(), opportunities: hints(6, 3, 200), drawn: ["farming"] };
  const text = (level: number) => part(goalParts(input), "hints").render(level);
  const lines = (level: number) => text(level).split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines(0).length, 6);
  assert.equal(lines(1).length, 4);
  // Level 2 keeps the 3 pressing lines (hints 1-3), shown in drawnFirst order: farming (hint2) first, then building.
  assert.equal(lines(2).length, 3);
  assert.ok(lines(2)[0]!.includes("hint2") && lines(2)[1]!.includes("hint1") && lines(2)[2]!.includes("hint3"));
  assert.equal(HINTS.lines, 6);
  // Past 1600 characters a hint goes at level 0 too: 3 lines of 400 characters fit, the fourth does not.
  const long: GoalInput = { ...input, opportunities: hints(6, 0, 400) };
  assert.equal(part(goalParts(long), "hints").render(0).split("\n").filter((line) => line.startsWith("- ")).length, 3);
});

test("lately, paused and history have their shrink levels, and the order of every tier names real parts", () => {
  const lately = part(goalParts({ ...goalWorst() }), "lately");
  assert.equal(lately.render(1).split("\n").filter((line) => line.startsWith("- ")).length, 3);
  assert.equal(lately.render(2).split("\n").filter((line) => line.startsWith("- ")).length, 1);
  assert.ok(lately.render(1).split("\n").every((line) => line.length <= 302));
  const paused = part(workParts(workWorst()), "paused");
  assert.match(paused.render(1), /objective c.*objective d.*and 2 more/u);
  assert.match(paused.render(2), /objective d.*and 3 more/u);
  const tiers = { work: workParts(workWorst()), goal: goalParts(goalWorst()), chat: chatParts(chatWorst(), true), narrate: narrateParts(narrateWorst(), "n", "t") };
  for (const tier of ["work", "goal", "chat", "narrate"] as const) {
    for (const key of SHRINK_ORDER[tier]) assert.ok(tiers[tier].some((candidate) => candidate.key === key && candidate.maxLevel > 0), `${tier}.${key}`);
  }
  const history = part(narrateParts(narrateWorst(), "n", "t"), "history");
  assert.equal(history.render(1).split("\n").length, 1 + 6);
  assert.equal(history.render(2).split("\n").length, 1 + 3);
});

test("a work prompt without steps or failures is as before", () => {
  const input: WorkInput = { ...workP50(), steps: [], earlierFailures: [], paused: [] };
  const text = fitPrompt("", workParts(input), SHRINK_ORDER.work, Number.POSITIVE_INFINITY, 3.4).text;
  assert.match(text, /Steps so far: none yet\./u);
  assert.doesNotMatch(text, /Steps that failed lately/u);
  assert.doesNotMatch(text, /Set aside/u);
});

// ---- the situation event part (spec 2026-11-15-p4-18-night-reflex-l2 D5) ----------------------------------------------

const hillcrest: KnownPlace = { name: "Hillcrest", detail: "", own: true, house: { size: "small", style: "medieval", door: { x: 3, y: 64, z: 0 }, facing: "north", materials: {} } };
const gather: Objective = { text: "gather the iron", requester: null, purpose: null };

/** A night event of a bot with a carried bed at 14000, its house 3 blocks east; `get_items` running unless told. */
function nightSituation(overrides: { readonly objective?: Objective | null; readonly ordinary?: Objective | null; readonly running?: string | null; readonly deciding?: boolean } = {}): NonNullable<WorkInput["situation"]> {
  const objective = overrides.objective === undefined ? gather : overrides.objective;
  const deciding = overrides.deciding ?? true;
  const info: SituationInfo = { kind: "night", cause: "Night has just fallen (day comes in 2.0 min)", raisedAt: 0 };
  const snapshot: BotSnapshot = {
    ...snapshotWith([{ name: "white_bed", count: 1, families: ["bed"] }]),
    armourPoints: 0,
    combat: { melee: null, bow: null, arrows: 0, shield: null },
    clock: { phase: "night", minutesUntilChange: 2, timeOfDay: 14_000 },
  };
  const view = situationView({
    info, snapshot, places: [hillcrest], objective, pushed: !deciding, skills: SKILL_NAMES, boldness: "steady",
    ordinary: overrides.ordinary === undefined ? gather : overrides.ordinary, deaths: { total: 0, atNight: 0 }, night: true, timeOfDay: 14_000,
  });
  return { info, view, objective, running: overrides.running === undefined ? "get_items" : overrides.running, deciding };
}

test("the situation part lists facts, weigh, then options in order", () => {
  const text = situationEventPart(nightSituation()).render(0);
  assert.equal(text, [
    '- Event: Night has just fallen (day comes in 2.0 min). Running now: get_items for "gather the iron".',
    '- Facts: your home "Hillcrest" is 3 blocks away (door at 3 64 0)',
    "- Weigh: boldness steady (cautious, steady or bold); gear: armour 0 points, bare hands; your own goal",
    '- What you can do now (your choice): carry on with "gather the iron": {"done":"carry on"}; go home: {"skill":"go_to","x":3,"y":64,"z":0}; sleep: {"skill":"sleep"}; dig an emergency shelter here: {"skill":"dig_shelter"}. Any other answer stops the running step at a safe place first.',
  ].join("\n"));
});

test("without a running step there is no Running now clause and no stop sentence; a later call says set aside", () => {
  const cases = [
    {
      name: "a pushed later call",
      situation: nightSituation({ objective: { text: "dig the well", requester: null, purpose: null }, deciding: false, running: null }),
      first: '- Event: Night has just fallen (day comes in 2.0 min). Set aside: "dig the well".',
      absent: /Running now|Any other answer/u,
    },
    {
      name: "a deciding call with nothing running",
      situation: nightSituation({ running: null }),
      first: "- Event: Night has just fallen (day comes in 2.0 min).",
      absent: /Running now|Set aside|Any other answer/u,
    },
  ] as const;
  for (const { name, situation, first, absent } of cases) {
    const text = situationEventPart(situation).render(0);
    const lines = text.split("\n");
    assert.equal(lines[0], first, name);
    assert.doesNotMatch(text, absent, name);
    assert.ok(lines[3]!.endsWith('{"skill":"dig_shelter"}.'), name);
  }
  assert.ok(situationEventPart(cases[0].situation).render(0).includes('leave this event: {"done":"carry on"}'));
});

test("level 1 drops the facts and keeps the weigh line and every form", () => {
  const situation = nightSituation();
  const text = situationEventPart(situation).render(1);
  assert.doesNotMatch(text, /- Facts: /u);
  assert.ok(text.includes("\n- Weigh: boldness steady (cautious, steady or bold); gear: armour 0 points, bare hands; your own goal\n- What you can do now"));
  for (const option of situation.view.options) assert.ok(text.includes(`${option.label}: ${option.form}`), option.label);
});

test("fitPrompt reaches the event part when the deficit needs it", () => {
  const input = workWorst();
  const parts = workParts(input);
  const order = SHRINK_ORDER.work;
  const earlier = order.filter((key) => key !== "situation-event");
  // Every earlier entry at its floor, the event whole: one token under that is a gap only the event's shrink can close.
  const earlierAtFloor = fitPrompt("", parts, earlier, Number.NEGATIVE_INFINITY, 3.4).estimated;
  const fitted = fitPrompt("", parts, order, earlierAtFloor - 1, 3.4);
  assert.equal(fitted.overBudget, false);
  assert.equal(fitted.text.includes("- Facts: "), false);
  assert.ok(fitted.text.includes("- Weigh: "));
  for (const option of input.situation!.view.options) assert.ok(fitted.text.includes(option.form), option.form);
});

test("a near-budget prompt keeps the event part whole and cuts the earliest steps first", () => {
  const input = workWorst();
  const parts = workParts(input);
  const whole = fitPrompt("", parts, SHRINK_ORDER.work, Number.POSITIVE_INFINITY, 3.4);
  const fitted = fitPrompt("", parts, SHRINK_ORDER.work, whole.estimated - 1, 3.4);
  assert.equal(fitted.overBudget, false);
  assert.ok(whole.text.includes("get 1 oak_log"), "the first step is shown whole at level 0");
  assert.equal(fitted.text.includes("get 1 oak_log"), false, "the first steps are cut once the deficit is one token");
  assert.ok(fitted.text.includes(situationEventPart(input.situation!).render(0)));
  const risk = "; risk with this gear 100% (100% = no gear)";
  for (const level of [0, 1]) assert.ok(situationEventPart(input.situation!).render(level).includes(risk), `level ${level}`);
  assert.ok(fitted.text.includes(risk));
});

test("a set-aside text with commas and quotes is shown as JSON at both levels", () => {
  const situation = nightSituation({ objective: { text: 'bring "the iron", the coal and the bread', requester: null, purpose: null }, deciding: false, running: null });
  for (const level of [0, 1]) {
    assert.ok(situationEventPart(situation).render(level).includes('Set aside: "bring \\"the iron\\", the coal and the bread".'), `level ${level}`);
  }
});

test("a set-aside text is shown whole at 119 and 120 characters and cut at 121 to 119 characters and an ellipsis, at both levels", () => {
  for (const [length, shown] of [
    [119, "a".repeat(119)],
    [120, "a".repeat(120)],
    [121, `${"a".repeat(119)}…`],
  ] as const) {
    const situation = nightSituation({ objective: { text: "a".repeat(length), requester: null, purpose: null }, deciding: false, running: null });
    for (const level of [0, 1]) {
      assert.ok(situationEventPart(situation).render(level).includes(`Set aside: "${shown}".`), `${length} characters at level ${level}`);
    }
  }
});

test("no situation: no event text; with one, the event sits between the situation block and the objective", () => {
  const withoutEvent = fitPrompt("", workParts({ ...workP50(), situation: undefined }), SHRINK_ORDER.work, Number.POSITIVE_INFINITY, 3.4).text;
  assert.doesNotMatch(withoutEvent, /- Event: /u);
  const withEvent = fitPrompt("", workParts(workWorst()), SHRINK_ORDER.work, Number.POSITIVE_INFINITY, 3.4).text;
  assert.match(withEvent, /- Currently doing: [^\n]*\n- Event: [\s\S]*\n\nObjective \(an event\)/u);
});

for (const deciding of [true, false]) test(`a situation objective is an event (deciding: ${deciding})`, () => {
  const input = { ...workP50(), situation: nightSituation({ deciding }) };
  const text = fitPrompt("", workParts(input), SHRINK_ORDER.work, Number.POSITIVE_INFINITY, 3.4).text;
  assert.match(text, /Objective \(an event\)/u);
});
