import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatModel, ChatReply, ChatTurn, ModelLane } from "./chat-model.ts";
import { ModelQueue, type QueueSnapshot } from "./model-queue.ts";
import { controlledModel, tick } from "./testing.ts";

// The chat lane (spec 2026-11-18 D1): `chatSlots` of the slots are kept for the chat tier's replies to a person's line.

const signal = new AbortController().signal;

const say = (content: string): ChatTurn[] => [{ role: "user", content }];

/** A call named `name` in `lane` at `priority`; `entered` of the controlled model lists the names in the order they ran. */
function ask(model: ChatModel, name: string, lane: ModelLane, priority: number, callSignal: AbortSignal = signal): Promise<ChatReply> {
  return model.complete(say(name), callSignal, { lane, priority });
}

function lanes(slots: number | null, chatSlots: number, file: string | null = null): { queue: ModelQueue; model: ChatModel; fake: ReturnType<typeof controlledModel> } {
  const queue = new ModelQueue({ slots, chatSlots, file });
  const fake = controlledModel();
  return { queue, model: queue.track(fake.model, "ada"), fake };
}

test("a chat call starts at once on the kept slot while two work calls run and a third waits", async () => {
  const { queue, model, fake } = lanes(3, 1);
  void ask(model, "w1", "shared", 4);
  void ask(model, "w2", "shared", 4);
  void ask(model, "w3", "shared", 4);
  const chat = ask(model, "chat", "chat", 0);
  assert.equal(fake.entered.length, 3, "the chat call reached the model with no await between");
  assert.deepEqual(fake.entered, ["w1", "w2", "chat"]);
  assert.equal(queue.waiting(), 1, "the third work call still waits");
  assert.equal(queue.inFlight(), 3);
  fake.settle(2);
  assert.equal((await chat).waitMs, 0);
});

test("a chat call may use an idle shared slot; once chat calls end, the held work call is granted", async () => {
  const { queue, model, fake } = lanes(3, 1);
  const chats = [ask(model, "c1", "chat", 0), ask(model, "c2", "chat", 0), ask(model, "c3", "chat", 0)];
  assert.deepEqual(fake.entered, ["c1", "c2", "c3"], "three chat calls take the kept slot and both shared ones");
  const work = ask(model, "w1", "shared", 4);
  await tick();
  assert.equal(queue.waiting(), 1, "no slot is free for the work call");
  fake.settle(0);
  fake.settle(1);
  fake.settle(2);
  await Promise.all(chats);
  await tick();
  assert.deepEqual(fake.entered, ["c1", "c2", "c3", "w1"]);
  assert.equal(queue.waiting(), 0, "no call stays held");
  fake.settle(3);
  await work;
  assert.equal(queue.inFlight(), 0);
});

test("one slot: chatSlots 0 keeps today's order, a held chat call goes before an earlier held work call", async () => {
  const { queue, model, fake } = lanes(1, 0);
  const busy = ask(model, "busy", "shared", 4);
  const work = ask(model, "work", "shared", 4);
  const chat = ask(model, "chat", "chat", 0);
  await tick();
  assert.equal(queue.waiting(), 2);
  fake.settle(0);
  await busy;
  await tick();
  fake.settle(1);
  await chat;
  await tick();
  fake.settle(2);
  await work;
  assert.deepEqual(fake.entered, ["busy", "chat", "work"]);
});

test("chatSlots refused: not below slots, not without known slots, not negative, not fractional", () => {
  assert.throws(() => new ModelQueue({ slots: 1, chatSlots: 1, file: null }), /\[BAD_CHAT_SLOTS\]/u);
  assert.throws(() => new ModelQueue({ slots: null, chatSlots: 1, file: null }), /\[BAD_CHAT_SLOTS\]/u);
  assert.throws(() => new ModelQueue({ slots: 3, chatSlots: -1, file: null }), /\[BAD_CHAT_SLOTS\]/u);
  assert.throws(() => new ModelQueue({ slots: 3, chatSlots: 1.5, file: null }), /\[BAD_CHAT_SLOTS\]/u);
  assert.doesNotThrow(() => new ModelQueue({ slots: null, chatSlots: 0, file: null }));
  assert.doesNotThrow(() => new ModelQueue({ slots: 3, file: null }), "absent means 0");
});

test("free, freeFor and whenFree read the shared lane, not the kept chat slot", async () => {
  const { queue, model, fake } = lanes(3, 1);
  assert.equal(queue.free(), true);
  void ask(model, "w1", "shared", 4);
  void ask(model, "w2", "shared", 4);
  assert.equal(queue.free(), false, "two work calls fill the shared lane; the kept slot is idle");
  assert.equal(queue.freeFor("a"), false);
  let freed = false;
  const waited = queue.whenFree(signal).then(() => { freed = true; });
  await tick();
  assert.equal(freed, false, "whenFree does not resolve on the kept slot");
  fake.settle(0);
  await waited;
  assert.equal(freed, true);
  assert.equal(queue.free(), true);
});

test("a held addressed line (priority 0) goes before an earlier held line to everyone (priority 1)", async () => {
  const { queue, model, fake } = lanes(3, 1);
  void ask(model, "w1", "shared", 4);
  void ask(model, "w2", "shared", 4);
  void ask(model, "busy-chat", "chat", 0);
  const everyone = ask(model, "to-everyone", "chat", 1);
  const addressed = ask(model, "addressed", "chat", 0);
  await tick();
  assert.equal(queue.waiting(), 2);
  fake.settle(2);
  await tick();
  assert.deepEqual(fake.entered, ["w1", "w2", "busy-chat", "addressed"]);
  fake.settle(3);
  await addressed;
  await tick();
  assert.deepEqual(fake.entered.at(-1), "to-everyone");
  fake.settle(4);
  await everyone;
});

test("an agent's line (shared lane, priority 2) never takes the kept slot", async () => {
  const { queue, model, fake } = lanes(3, 1);
  void ask(model, "w1", "shared", 4);
  void ask(model, "w2", "shared", 4);
  void ask(model, "agent-line", "shared", 2);
  await tick();
  assert.equal(queue.waiting(), 1, "held although the kept slot is idle");
  assert.equal(queue.inFlight(), 2);
  void ask(model, "person-line", "chat", 0);
  assert.deepEqual(fake.entered, ["w1", "w2", "person-line"], "a person's line then enters at once");
});

test("an aborted held chat call leaves the queue and the next held call of either lane is still granted", async () => {
  const { queue, model, fake } = lanes(3, 1);
  void ask(model, "w1", "shared", 4);
  void ask(model, "w2", "shared", 4);
  void ask(model, "c1", "chat", 0);
  const abort = new AbortController();
  const aborted = ask(model, "c-aborted", "chat", 0, abort.signal);
  const work = ask(model, "w3", "shared", 4);
  const chat = ask(model, "c2", "chat", 1);
  await tick();
  assert.equal(queue.waiting(), 3);
  abort.abort(new Error("stopped"));
  await assert.rejects(aborted, /stopped/u);
  assert.equal(queue.waiting(), 2);
  fake.settle(2);
  await tick();
  assert.deepEqual(fake.entered.at(-1), "c2", "the chat lane's next call takes the slot a chat call freed (w3 may not: the shared lane is full)");
  assert.equal(queue.waiting(), 1);
  fake.settle(0);
  await tick();
  assert.deepEqual(fake.entered.at(-1), "w3", "a work call ending lets the held work call in");
  assert.equal(queue.waiting(), 0);
  fake.settle(1);
  fake.settle(3);
  fake.settle(4);
  await Promise.all([work, chat]);
  assert.equal(queue.inFlight(), 0);
});

test("the snapshot holds chatSlots, chatInFlight and chatWaiting", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "model-queue-lanes-")), "queue.json");
  const { queue, model } = lanes(2, 1, file);
  void ask(model, "w1", "shared", 4);
  void ask(model, "c1", "chat", 0);
  void ask(model, "c2", "chat", 0);
  await tick();
  queue.flush();
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as QueueSnapshot;
  assert.equal(snapshot.slots, 2);
  assert.equal(snapshot.chatSlots, 1);
  assert.equal(snapshot.chatInFlight, 1);
  assert.equal(snapshot.chatWaiting, 1);
  assert.equal(snapshot.inFlight, 2);
  assert.equal(snapshot.waiting, 1);
});
