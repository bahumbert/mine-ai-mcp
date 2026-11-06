import assert from "node:assert/strict";
import test from "node:test";
import { EARLIER_GAIN_MS } from "./earlier.ts";
import { GiveBook } from "./gives.ts";
import { TradeLedgers } from "./ledgers.ts";
import { cancelTrade, proposeTrade } from "./trade.ts";
import type { ItemCount, Trade } from "./types.ts";

const t0 = 1_000_000;
const SEC = 1_000;
const deal = { self: "Finn", partner: "Owner", give: [{ item: "cobblestone", count: 60 }], get: [{ item: "cooked_beef", count: 16 }], first: "them" as const, now: t0 };

function ledgersFor(trades: Trade[] = [], recordReceived: (t: Trade) => Promise<void> = () => Promise.resolve()) {
  const gives = new GiveBook(() => t0, 60 * 60 * SEC);
  const ledgers = new TradeLedgers({ gives, find: (id) => trades.find((t) => t.id === id), recordReceived });
  return { gives, ledgers };
}

test("a proposal takes the partner's earlier gives and remembers them; they go back to the ledger when it is cancelled unagreed, not when it had been agreed", async () => {
  const { gives, ledgers } = ledgersFor();
  ledgers.earlier.gave("Owner", "cobblestone", 20, t0);
  const proposed = proposeTrade(deal);
  await ledgers.claimEarlier(proposed, t0 + SEC, []);
  assert.deepEqual(gives.givenOf(proposed.id), new Map([["cobblestone", 20]]));
  assert.deepEqual(ledgers.carriedOver(proposed.id), [{ item: "cobblestone", count: 20 }]);
  assert.deepEqual(ledgers.earlier.givesTo("Owner", t0 + SEC), [], "the ledger gave them to the proposal");
  ledgers.tradeEnded(cancelTrade(proposed, t0 + 2 * SEC, "replaced"), t0 + 2 * SEC);
  assert.equal(ledgers.carriedOver(proposed.id), undefined);
  assert.deepEqual(ledgers.earlier.givesTo("Owner", t0 + 3 * SEC), [{ item: "cobblestone", count: 20 }]);
  const agreedLater = proposeTrade({ ...deal, partner: "Theo" });
  ledgers.earlier.gave("Theo", "cobblestone", 5, t0 + 4 * SEC);
  await ledgers.claimEarlier(agreedLater, t0 + 5 * SEC, []);
  ledgers.tradeEnded({ ...cancelTrade(agreedLater, t0 + 6 * SEC, "x"), agreedAt: t0 + 5 * SEC }, t0 + 6 * SEC);
  assert.deepEqual(ledgers.earlier.givesTo("Theo", t0 + 7 * SEC), []);
});

test("an agreed trade takes the payment kept from its partner; a failed write keeps the payment for the retry", async () => {
  const agreed: Trade = { ...proposeTrade(deal), state: "agreed", agreedAt: t0 };
  const bag: { name: string; count: number }[] = [{ name: "cooked_beef", count: 16 }];
  const written: ItemCount[][] = [];
  const { ledgers } = ledgersFor([agreed], (t) => { written.push([...t.received]); return Promise.reject(new Error("disk")); });
  ledgers.earlier.heard("Owner", t0);
  ledgers.earlier.gained([{ item: "cooked_beef", count: 16 }], new Map([["owner", 2]]), t0 + SEC);
  await assert.rejects(ledgers.claimEarlier(agreed, t0 + 2 * SEC, bag), /disk/);
  assert.deepEqual(written[0], [{ item: "cooked_beef", count: 16 }], "the write was attempted with the payment credited");
  assert.deepEqual(ledgers.earlier.keptFrom("Owner", t0 + 3 * SEC), [{ item: "cooked_beef", count: 16 }], "the payment is kept again for the retry");
});

test("a line heard inside the opening distance opens the watch; one from afar or of unknown distance does not", () => {
  const { ledgers } = ledgersFor();
  ledgers.heard([], "Owner", t0, 30, 8);
  assert.equal(ledgers.watching(t0 + SEC), false);
  ledgers.heard([], "Owner", t0, null, 8);
  assert.equal(ledgers.watching(t0 + SEC), false);
  ledgers.heard([], "Owner", t0, 4, 8);
  assert.equal(ledgers.watching(t0 + SEC), true);
  assert.equal(ledgers.watching(t0 + EARLIER_GAIN_MS + SEC), false, "the window closes");
});
