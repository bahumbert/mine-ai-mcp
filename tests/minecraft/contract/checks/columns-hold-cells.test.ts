import assert from "node:assert/strict";
import test from "node:test";
import type { ContractSubject } from "../subject.ts";
import { columnsHoldCells } from "./columns-hold-cells.ts";
import { runOnFake } from "./run-on-fake.ts";

/** The subject's world lists `perSecond` more of its columns each second of the run's clock, up to `limit` of them (the chunks a slow server sends one by one). */
function withChunksArrivingAt(subject: ContractSubject, perSecond: number, limit = Infinity): ContractSubject {
  const startedAt = subject.now();
  const world = new Proxy(subject.bot.world, {
    get(target, property, receiver) {
      if (property !== "getColumns") return Reflect.get(target, property, receiver);
      return () => (Reflect.get(target, "getColumns") as () => unknown[])().slice(0, Math.min(limit, Math.floor(((subject.now() - startedAt) / 1_000) * perSecond)));
    },
  });
  const bot = new Proxy(subject.bot, { get: (target, property) => (property === "world" ? world : Reflect.get(target, property, target)) });
  return { ...subject, bot };
}

test("columns-hold-cells passes while chunks keep arriving, past 20 s: 329 chunks at 10 a second take 33 s", async () => {
  await runOnFake(columnsHoldCells, {}, (subject) => withChunksArrivingAt(subject, 10));
});

test("columns-hold-cells fails, with the count, when no new chunk arrives for the answer bound", async () => {
  await assert.rejects(
    runOnFake(columnsHoldCells, {}, (subject) => withChunksArrivingAt(subject, 10, 100)),
    /100 of \d+ chunks listed, no new one for 10000 ms/,
  );
});
