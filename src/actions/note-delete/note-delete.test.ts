import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createNoteSaveAction } from "../note-save/index.js";
import { createNoteDeleteAction, parseNoteDeleteRequest } from "./index.js";

const request = { note: "I spent 3 min farming.", context: "activity time" };

test("a bot deletes its own notes by id, never another bot's; missing ids are reported", async () => {
  using data = temporaryBotData({ botId: "Ayla" });
  const ayla = createNoteSaveAction(createFakeBot({ username: "Ayla", position: { x: 0, y: 64, z: 0 } }).bot, data);
  const vex = createNoteSaveAction(createFakeBot({ username: "Vex", position: { x: 0, y: 64, z: 0 } }).bot, data);
  const first = (await ayla.execute(request, {})).note.noteId;
  const second = (await ayla.execute(request, {})).note.noteId;
  const others = (await vex.execute(request, {})).note.noteId;
  const remove = createNoteDeleteAction(data, "Ayla");
  assert.equal(remove.annotations?.destructiveHint, true);
  const result = await remove.execute(remove.parse({ note_ids: [first, others, 999, first] }), {});
  assert.deepEqual(result, { status: "succeeded", deleted: [first], notDeleted: [others, 999] });
  remove.resultSchema.parse(result);
  assert.deepEqual(data.read("SELECT note_id FROM notes ORDER BY note_id").map((row) => row.note_id), [second, others]);
});

test("note_delete takes 1 to 500 positive integer ids", () => {
  for (const note_ids of [[], [0], [1.5], ["1"], Array.from({ length: 501 }, (_, i) => i + 1)]) assert.throws(() => parseNoteDeleteRequest({ note_ids }));
  assert.deepEqual(parseNoteDeleteRequest({ note_ids: [3, 4] }), { note_ids: [3, 4] });
});
