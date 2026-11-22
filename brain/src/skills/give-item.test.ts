// give_item: the hand-over's answers and what an agreed trade owes to someone else.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { runStep } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import { contextFor, owedToAyla } from "./skill-fixtures.test.ts";

const stevesFeet = (runtime: FakeRuntime, carried: number): void => {
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Steve", position: { x: 3, y: 64, z: 0 } }], inventory: [{ name: "crafting_table", count: carried }] };
};

const heldTable = [{ item: "crafting_table", count: 1, partner: "Ayla", tradeId: "t1", held: true as const }];

const HELD_TABLE_WORDS = "1 crafting_table Ayla handed over for a trade that ended, not given back";

test("a hand-over to a recipient on a ledge out of reach is a failed give with reason recipient_unreachable, not recipient_busy", async () => {
  const step = stepSchema.parse({ skill: "give_item", player: "Steve", item: "oak_log", count: 3 });
  const ledge = new FakeRuntime();
  ledge.walkOnNavigate = true;
  ledge.snapshot = { ...ledge.snapshot, players: [{ username: "Steve", position: { x: 3, y: 64, z: 0 } }] };
  const error = "[DROP_RECIPIENT_OUT_OF_REACH] Steve stands still 2 blocks above me, where I found no floor to toss from that lets an item rest at their feet; nothing was tossed. Ask them to come down to me, or walk to where they are.";
  ledge.dropOutcomes.push({ status: "failed", error, dropped: [{ item: "oak_log", dropped: 0 }] });
  const result = await runStep(step, contextFor(ledge));
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" ? result.reason : "", "recipient_unreachable");
  assert.equal(result.status === "failed" ? result.detail : "", error);
});

test("a recipient on a pillar the walk cannot reach still gets the drop's own answer: recipient_unreachable, not the walk's error (F3)", async () => {
  const step = stepSchema.parse({ skill: "give_item", player: "Steve", item: "oak_log", count: 3 });
  const pillar = new FakeRuntime();
  pillar.failures.navigate = "[NO_PATH] no path to Steve";
  pillar.snapshot = { ...pillar.snapshot, players: [{ username: "Steve", position: { x: 3, y: 66, z: 0 } }] };
  const error = "[DROP_RECIPIENT_OUT_OF_REACH] Steve stands still 2 blocks above me, where I found no floor to toss from that lets an item rest at their feet; nothing was tossed. Ask them to come down to my floor, then hand over again.";
  pillar.dropOutcomes.push({ status: "failed", error, dropped: [{ item: "oak_log", dropped: 0 }] });
  const result = await runStep(step, contextFor(pillar));
  assert.equal(result.status === "failed" ? result.reason : "", "recipient_unreachable");
  assert.equal(result.status === "failed" ? result.detail : "", error);
});

test("a walk that failed far from the recipient keeps its own error and tosses nothing: distance is not a ledge (F3)", async () => {
  const step = stepSchema.parse({ skill: "give_item", player: "Steve", item: "oak_log", count: 3 });
  const far = new FakeRuntime();
  far.failures.navigate = "[NO_PATH] no path to Steve";
  far.snapshot = { ...far.snapshot, players: [{ username: "Steve", position: { x: 40, y: 66, z: 0 } }] };
  const result = await runStep(step, contextFor(far));
  assert.deepEqual(result, { status: "failed", detail: "[NO_PATH] no path to Steve" });
  assert.equal(far.submitted.filter((call) => call.tool === "drop_item").length, 0);
});

test("a give to a recipient out of sight still stops at 'cannot see' without a drop (F3)", async () => {
  const step = stepSchema.parse({ skill: "give_item", player: "Steve", item: "oak_log", count: 3 });
  const unseen = new FakeRuntime();
  const result = await runStep(step, contextFor(unseen));
  assert.deepEqual(result, { status: "failed", detail: "cannot see Steve: Steve is not online now" });
  assert.equal(unseen.submitted.filter((call) => call.tool === "drop_item").length, 0);
});

test("give says the recipient took the items, or that they were left at their feet (B2, live 2026-10-19: reported gave, never arrived)", async () => {
  const step = stepSchema.parse({ skill: "give_item", player: "Steve", item: "oak_log", count: 3 });
  const taken = new FakeRuntime();
  taken.walkOnNavigate = true;
  taken.snapshot = { ...taken.snapshot, players: [{ username: "Steve", position: { x: 3, y: 64, z: 0 } }] };
  taken.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "oak_log", dropped: 3 }], recipient: { collected: true, collectedCount: 3 } });
  const gave = await runStep(step, contextFor(taken));
  assert.equal(gave.status === "done" ? gave.detail : "", "gave 3 oak_log to Steve");

  const left = new FakeRuntime();
  left.walkOnNavigate = true;
  left.snapshot = { ...left.snapshot, players: [{ username: "Steve", position: { x: 3, y: 64, z: 0 } }] };
  left.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "oak_log", dropped: 3 }], recipient: { collected: false, collectedCount: 0 } });
  const notYet = await runStep(step, contextFor(left));
  assert.equal(notYet.status === "done" ? notYet.detail : "", "left 3 oak_log at Steve's feet (not picked up yet)");

  const picked = new FakeRuntime();
  picked.walkOnNavigate = true;
  picked.snapshot = { ...picked.snapshot, players: [{ username: "Steve", position: { x: 3, y: 64, z: 0 } }] };
  picked.dropOutcomes.push({ status: "failed", error: "[DROP_PICKED_UP] oak_log came back", dropped: [{ item: "oak_log", dropped: 0 }] });
  const failed = await runStep(step, contextFor(picked));
  assert.equal(failed.status, "failed");
});

test("give hands over the item in hand too (trade5, 2026-10-20: [DROP_HELD] on the iron in Theo's hand)", async () => {
  const step = stepSchema.parse({ skill: "give_item", player: "Steve", item: "iron_ingot", count: 2 });
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Steve", position: { x: 3, y: 64, z: 0 } }] };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "iron_ingot", dropped: 2 }], recipient: { collected: true, collectedCount: 2 } });
  const result = await runStep(step, contextFor(runtime));
  assert.equal(result.status, "done");
  const drops = runtime.submitted.filter((call) => call.tool === "drop_item");
  assert.equal(drops.length, 1);
  assert.equal(drops[0]!.input.allow_equipped, true);
  assert.equal(drops[0]!.input.to_player, "Steve");
  assert.deepEqual(drops[0]!.input.items, [{ item_name: "iron_ingot", count: 2 }]);
});

test("give refuses an item an agreed trade owes to someone else, before any walk, and says how many can go", async () => {
  const runtime = new FakeRuntime();
  stevesFeet(runtime, 1);
  const step = stepSchema.parse({ skill: "give_item", player: "Steve", item: "crafting_table", count: 1 });
  const refused = await runStep(step, contextFor(runtime, { owed: () => owedToAyla }));
  assert.equal(refused.status, "failed");
  assert.match(refused.status === "failed" ? refused.detail : "", /you owe 1 crafting_table to Ayla \(trade\): you can give 0/u);
  assert.deepEqual(runtime.submitted, []);
});

test("give hands over what is spare beyond the owed count, and to the trade's own partner what other trades do not owe", async () => {
  const spare = new FakeRuntime();
  stevesFeet(spare, 3);
  const two = await runStep(stepSchema.parse({ skill: "give_item", player: "Steve", item: "crafting_table", count: 2 }), contextFor(spare, { owed: () => owedToAyla }));
  assert.equal(two.status, "done");
  const three = await runStep(stepSchema.parse({ skill: "give_item", player: "Steve", item: "crafting_table", count: 3 }), contextFor(spare, { owed: () => owedToAyla }));
  assert.equal(three.status, "failed");
  assert.match(three.status === "failed" ? three.detail : "", /you can give 2/u);

  const partner = new FakeRuntime();
  partner.walkOnNavigate = true;
  partner.snapshot = { ...partner.snapshot, players: [{ username: "Ayla", position: { x: 3, y: 64, z: 0 } }], inventory: [{ name: "crafting_table", count: 1 }] };
  const toAyla = await runStep(stepSchema.parse({ skill: "give_item", player: "ayla", item: "crafting_table", count: 1 }), contextFor(partner, { owed: () => owedToAyla }));
  assert.equal(toAyla.status, "done", "the owed item goes to the one it is owed to, whatever the case of the name");
});

test("give and drop_item word a held payment as held, with what can go and a next step, never as owed", async () => {
  const runtime = new FakeRuntime();
  stevesFeet(runtime, 1);
  const refused = await runStep(stepSchema.parse({ skill: "give_item", player: "Steve", item: "crafting_table", count: 1 }), contextFor(runtime, { owed: () => heldTable }));
  assert.equal(refused.status, "failed");
  const detail = refused.status === "failed" ? refused.detail : "";
  assert.ok(detail.includes(`you hold ${HELD_TABLE_WORDS}: you can give 0; keep the rest for them`), detail);
  assert.doesNotMatch(detail, /you owe/u);
  assert.deepEqual(runtime.submitted, []);

  const dropping = new FakeRuntime();
  dropping.snapshot = { ...dropping.snapshot, inventory: [{ name: "crafting_table", count: 1 }, { name: "dirt", count: 2 }] };
  const dropped = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "crafting_table" }, { item: "dirt" }] }), contextFor(dropping, { requester: "Finn", owed: () => heldTable }));
  const droppedDetail = dropped.status === "done" ? dropped.detail : "";
  assert.ok(droppedDetail.includes(`kept 1 crafting_table: you hold ${HELD_TABLE_WORDS}: you can drop 0`), droppedDetail);
  assert.doesNotMatch(droppedDetail, /you owe/u);
});

test("give with a held entry and an agreed one for another partner says both; the held partner gets its payment back", async () => {
  const runtime = new FakeRuntime();
  stevesFeet(runtime, 2);
  const both = [...owedToAyla.map((o) => ({ ...o, partner: "Bruno" })), ...heldTable];
  const refused = await runStep(stepSchema.parse({ skill: "give_item", player: "Steve", item: "crafting_table", count: 2 }), contextFor(runtime, { owed: () => both }));
  const detail = refused.status === "failed" ? refused.detail : "";
  assert.ok(detail.includes(`you owe 1 crafting_table to Bruno (trade); you hold ${HELD_TABLE_WORDS}: you can give 0`), detail);
  const back = new FakeRuntime();
  stevesFeet(back, 1);
  back.snapshot = { ...back.snapshot, players: [{ username: "Ayla", position: { x: 3, y: 64, z: 0 } }] };
  const given = await runStep(stepSchema.parse({ skill: "give_item", player: "Ayla", item: "crafting_table", count: 1 }), contextFor(back, { owed: () => heldTable }));
  assert.equal(given.status, "done", "a give back to the one who handed it over is not held back");
});
