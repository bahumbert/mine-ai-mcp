import assert from "node:assert/strict";
import test from "node:test";
import type { TradeDecision } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { FakeRuntime, scriptedMind, testPersona } from "../testing.ts";
import { TradeBoard } from "./board.ts";
import { RelationBook } from "./book.ts";
import { TradeController } from "./controller.ts";
import type { Handoff } from "./handoff.ts";
import type { ItemCount, TradeSettings } from "./types.ts";

const t0 = 1_000_000;
const settings: TradeSettings = { payBackMinutes: 10, startMinutes: 3, handoffDistance: 4, offersForgetMinutes: 60, maxOpenTrades: 3, tradeReach: 32 };
const bread = (count: number): ItemCount[] => [{ item: "bread", count }];
const logs = (count: number): ItemCount[] => [{ item: "oak_log", count }];
const state = { now: t0 };

function bot(self: string, board: TradeBoard | undefined) {
  const handoffs: Handoff[] = [];
  const lines: string[] = [];
  const book = new RelationBook({ save: async () => {}, remove: async () => {}, now: () => state.now, log: (l) => lines.push(l) });
  const { mind } = scriptedMind();
  const c = new TradeController({
    self, persona: testPersona(), book, mind, settings, now: () => state.now, takeHandoff: (h) => { if (h.kind === "give") handoffs.push(h); },
    modelSlotFree: () => true, inConversationWith: () => false, journal: () => {}, log: (l) => lines.push(l), ...(board !== undefined && { board }),
  });
  const snapshot = (inventory: BotSnapshot["inventory"] = [{ name: "bread", count: 10 }, { name: "oak_log", count: 10 }]): BotSnapshot => ({ ...new FakeRuntime().snapshot, inventory, players: ["Finn", "Ayla", "Theo", "Lena"].map((username) => ({ username, position: { x: 2, y: 64, z: 0 } })) });
  const latest = (partner: string) => book.get(partner)?.trades.at(-1);
  return { c, book, handoffs, lines, snapshot, latest };
}

const propose = (give: ItemCount[], get: ItemCount[], first: "me" | "them" = "me"): TradeDecision => ({ action: "propose", give, get, first });
const accept = (give: ItemCount[], get: ItemCount[], first: "me" | "them" = "me"): TradeDecision => ({ action: "accept", give, get, first });

function pair() {
  const board = new TradeBoard();
  return { board, finn: bot("Finn", board), ayla: bot("Ayla", board) };
}

test("an accept with other terms takes the proposer's terms, mirrored, under the proposer's id", async () => {
  const { finn, ayla } = pair();
  const id = await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot());
  assert.equal(await ayla.c.onDecision(accept(logs(1), bread(1)), "Finn", ayla.snapshot()), id, "the proposer's id");
  await finn.c.settled();
  for (const trade of [finn.latest("Ayla")!, ayla.latest("Finn")!]) assert.equal(trade.state, "agreed");
  assert.equal(finn.latest("Ayla")!.id, ayla.latest("Finn")!.id);
  assert.deepEqual(ayla.latest("Finn")!.give, logs(8));
  assert.deepEqual(ayla.latest("Finn")!.get, bread(8));
  assert.deepEqual(finn.latest("Ayla")!.give, bread(8));
  assert.ok(ayla.lines.some((line) => /terms taken from Finn's offer/u.test(line)));
  assert.equal(finn.handoffs.length, 1, "Finn goes first: his give starts");
  assert.deepEqual(finn.handoffs[0]?.kind === "give" ? finn.handoffs[0].items : null, bread(8));
});

test("an accept with the proposer's own terms logs no change", async () => {
  const { finn, ayla } = pair();
  await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot());
  await ayla.c.onDecision(accept(logs(8), bread(8), "them"), "Finn", ayla.snapshot());
  assert.ok(!ayla.lines.some((line) => /terms taken/u.test(line)));
});

test("an accept the accepter cannot pay is refused with the proposer's terms and the proposal stays open", async () => {
  const { board, finn, ayla } = pair();
  await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot());
  const poor = ayla.snapshot([{ name: "bread", count: 10 }, { name: "oak_log", count: 3 }]);
  assert.match(ayla.c.checkDecision(accept(logs(1), bread(1)), "Finn", poor) ?? "", /carry 3 oak_log, not 8/u);
  assert.equal(ayla.c.checkDecision(accept(logs(1), bread(1)), "Finn", ayla.snapshot()), null, "carrying enough for his terms passes, whatever the model wrote");
  assert.notEqual(board.offerFrom("Finn", "Ayla"), undefined);
  assert.equal(finn.latest("Ayla")!.state, "proposed");
});

test("my accept with no proposal to me becomes a counter-offer; the partner's accept closes it on both sides", async () => {
  const { board, finn, ayla } = pair();
  // Lena offered in words only: Theo's accept is all there is.
  const theo = bot("Theo", board);
  const lena = bot("Lena", board);
  const id = await theo.c.onDecision(accept(logs(2), bread(2)), "Lena", theo.snapshot());
  assert.equal(theo.latest("Lena")!.state, "proposed");
  assert.equal(lena.latest("Theo"), undefined, "Lena has nothing yet");
  assert.equal(board.offerFrom("Theo", "Lena")?.id, id);
  assert.equal(await lena.c.onDecision(accept(bread(2), logs(2)), "Theo", lena.snapshot()), id);
  await theo.c.settled();
  assert.equal(theo.latest("Lena")!.state, "agreed");
  assert.equal(lena.latest("Theo")!.state, "agreed");
  assert.equal(lena.latest("Theo")!.id, id);
  assert.equal(board.offerFrom("Theo", "Lena"), undefined);
  assert.equal(finn.latest("Ayla"), undefined);
  void ayla;
});

test("two proposals that cross: the older stands, the newer is dropped with a log line", async () => {
  const { board, finn, ayla } = pair();
  const kept = await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot());
  assert.equal(await ayla.c.onDecision(propose(logs(3), bread(3)), "Finn", ayla.snapshot()), null);
  assert.equal(ayla.latest("Finn"), undefined, "nothing recorded");
  assert.ok(ayla.lines.some((line) => /proposal to Finn dropped.*older/u.test(line)));
  assert.equal(board.offerFrom("Finn", "Ayla")?.id, kept);
  assert.equal(board.offerFrom("Ayla", "Finn"), undefined);
});

test("a decline cancels the proposer's record and clears the board", async () => {
  const { board, finn, ayla } = pair();
  await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot());
  await ayla.c.onDecision({ action: "decline", give: [], get: [], first: "me" }, "Finn", ayla.snapshot());
  await finn.c.settled();
  assert.equal(finn.latest("Ayla")!.state, "cancelled");
  assert.match(finn.latest("Ayla")!.note, /Ayla declined/u);
  assert.equal(board.offerFrom("Finn", "Ayla"), undefined);
});

test("a proposer who cancels clears the board: a later accept is a counter-offer, not an agreement on a dead trade", async () => {
  const { board, finn, ayla } = pair();
  await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot());
  await finn.c.onDecision({ action: "cancel", give: [], get: [], first: "me" }, "Ayla", finn.snapshot());
  assert.equal(board.offerFrom("Finn", "Ayla"), undefined);
  await ayla.c.onDecision(accept(logs(1), bread(1)), "Finn", ayla.snapshot());
  assert.equal(ayla.latest("Finn")!.state, "proposed");
  assert.equal(finn.latest("Ayla")!.state, "cancelled");
});

test("a proposal that ran out of time leaves the board", async () => {
  const { board, finn } = pair();
  await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot());
  state.now += 4 * 60_000;
  await finn.c.tick(finn.snapshot(), new Set(), new AbortController().signal);
  assert.equal(finn.latest("Ayla")!.state, "cancelled");
  assert.equal(board.offerFrom("Finn", "Ayla"), undefined);
  state.now = t0;
});

test("a partner who is not a bot of this brain: no board entry, the accept is the agreement as before", async () => {
  const { board, ayla } = pair();
  await ayla.c.onDecision(propose(bread(2), logs(2)), "Steve", ayla.snapshot());
  assert.equal(board.offerFrom("Ayla", "Steve"), undefined);
  await ayla.c.onDecision(accept(bread(2), logs(2)), "Steve", ayla.snapshot());
  assert.equal(ayla.latest("Steve")!.state, "agreed");
  const other = bot("Zed", board);
  await other.c.onDecision(accept(bread(1), logs(1)), "Steve", other.snapshot());
  assert.equal(other.latest("Steve")!.state, "agreed");
});

test("after a restart the board is empty and the books keep their records: an accept is a counter-offer", async () => {
  const { finn, ayla } = pair();
  await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot());
  const fresh = new TradeBoard();
  bot("Finn", fresh);
  const restarted = bot("Ayla", fresh);
  await restarted.c.onDecision(accept(logs(1), bread(1)), "Finn", restarted.snapshot());
  assert.equal(restarted.latest("Finn")!.state, "proposed");
  assert.equal(finn.latest("Ayla")!.state, "proposed", "Finn's record is untouched");
  void ayla;
});

const signal = new AbortController().signal;
const withGains = (s: BotSnapshot, name: string, count: number): BotSnapshot => ({ ...s, inventory: [...s.inventory, { name, count }], players: [{ username: "Finn", position: s.position }] });

/** Finn proposed 8 bread for 8 logs, going first, and Ayla accepted: Ayla's record runs to `done`. */
async function ayla8LogsDone(finn: ReturnType<typeof bot>, ayla: ReturnType<typeof bot>): Promise<string> {
  const id = (await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot()))!;
  const before = ayla.snapshot();
  await ayla.c.onDecision(accept(logs(8), bread(8), "them"), "Finn", before);
  await ayla.c.tick(before, new Set(), signal);
  state.now += 1_000;
  await ayla.c.tick(withGains(before, "bread", 8), new Set(), signal);
  await ayla.c.handoffEnded(id, "done", "gave");
  assert.equal(ayla.latest("Finn")!.state, "done");
  return id;
}

test("F9: Ayla's late accept of the swap that was just done is no counter-offer: no record, nothing on the board", async () => {
  state.now = t0;
  const { board, finn, ayla } = pair();
  await ayla8LogsDone(finn, ayla);
  state.now += 3_500;
  assert.equal(await ayla.c.onDecision(accept(logs(8), bread(8), "them"), "Finn", ayla.snapshot()), null);
  assert.equal(ayla.book.get("Finn")!.trades.length, 1);
  assert.equal(board.offerFrom("Ayla", "Finn"), undefined);
  assert.ok(ayla.lines.some((l) => /a accept of Finn ignored, it repeats/u.test(l)));
  state.now = t0;
});

test("F9: the same terms after 2 min 1 s are a counter-offer again", async () => {
  state.now = t0;
  const { board, finn, ayla } = pair();
  await ayla8LogsDone(finn, ayla);
  state.now += 2 * 60_000 + 1_000;
  const id = await ayla.c.onDecision(accept(logs(8), bread(8), "them"), "Finn", ayla.snapshot());
  assert.notEqual(id, null);
  assert.equal(board.offerFrom("Ayla", "Finn")?.id, id);
  state.now = t0;
});

test("F9: a repeat ignored leaves no trace: a real new proposal from that partner right after is agreed and reaches done", async () => {
  state.now = t0;
  const { board, finn, ayla } = pair();
  await ayla8LogsDone(finn, ayla);
  state.now += 3_500;
  assert.equal(await ayla.c.onDecision(accept(logs(8), bread(8), "them"), "Finn", ayla.snapshot()), null);
  // The partner's own, new proposal (posted straight on the board: Finn's controller would block a repeat of his own).
  board.post({ id: "Finn-Ayla-new", proposer: "Finn", partner: "Ayla", give: bread(8), get: logs(8), first: "me", postedAt: state.now });
  assert.equal(await ayla.c.onDecision(accept(logs(8), bread(8), "them"), "Finn", ayla.snapshot()), "Finn-Ayla-new");
  assert.equal(ayla.latest("Finn")!.state, "agreed");
  const before = ayla.snapshot();
  await ayla.c.tick(before, new Set(), signal);
  state.now += 1_000;
  await ayla.c.tick(withGains(before, "bread", 8), new Set(), signal);
  await ayla.c.handoffEnded("Finn-Ayla-new", "done", "gave");
  assert.equal(ayla.latest("Finn")!.state, "done");
  assert.equal(ayla.book.get("Finn")!.trades.length, 2);
  state.now = t0;
});
