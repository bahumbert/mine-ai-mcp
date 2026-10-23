import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { persistentBotData, temporaryBotData } from "../../test-support/bot-data.js";
import { createNoteReadAction, parseNoteReadRequest } from "../note-read/index.js";
import { createNoteSaveAction, parseNoteSaveRequest } from "./index.js";

function noteBot(username = "NoteBot") {
  return createFakeBot({ username, position: { x: 12.5, y: 64, z: -3.25 }, server: { startAge: 24000 } });
}

/** A bot that has not had its first time packet: `bot.time.age` is null. */
function noteBotBeforeFirstTimePacket(username: string) {
  const harness = noteBot(username);
  // Stopgap until the master adds a server with no time packet yet: mineflayer `lib/plugins/time.js` starts `bot.time.age` as null.
  Object.defineProperty(harness.bot, "time", { value: { ...harness.bot.time, age: null }, configurable: true });
  return harness;
}

const request = { note: "Bring a bucket", context: "Found lava while looking for iron." };

test("note contracts require meaningful text and a positive integer count", () => {
  assert.deepEqual(parseNoteSaveRequest({ note: "  A fact  ", context: "  Why  " }), {
    note: "A fact",
    context: "Why",
  });
  for (const input of [
    { note: " ", context: "why" },
    { note: "fact", context: " " },
    { note: "fact" },
    { ...request, x: 0 },
  ]) {
    assert.throws(() => parseNoteSaveRequest(input));
  }
  assert.deepEqual(parseNoteReadRequest({}), { n: 10 });
  assert.deepEqual(parseNoteReadRequest({ n: 200 }), { n: 200 });
  for (const n of [0, -1, 1.5, "2", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseNoteReadRequest({ n }));
  }
});

test("notes persist across reopen, snapshot location and time, and read newest first without consumption", async (t) => {
  const storage = persistentBotData(t);
  {
    const first = await (async () => {
      using data = storage.open("notes-test");
      const { bot, clock } = noteBot();
      const save = createNoteSaveAction(bot, data);
      const read = createNoteReadAction(data, bot.username);
      assert.equal(save.annotations?.readOnlyHint, false);
      assert.equal(read.annotations?.readOnlyHint, true);
      assert.equal(read.execution.kind, "information");
      assert.deepEqual((await read.execute({ n: 10 }, {})).notes, []);

      const before = Date.now();
      const saved = await save.execute(save.parse(request), {});
      assert.ok(Date.parse(saved.note.rememberedAt) >= before);
      assert.ok(Date.parse(saved.note.rememberedAt) <= Date.now());
      assert.deepEqual(saved.note, {
        noteId: 1,
        botId: "NoteBot",
        ...request,
        rememberedAt: saved.note.rememberedAt,
        dimension: "overworld",
        position: { x: 12.5, y: 64, z: -3.25 },
        worldAgeTicks: 24000,
      });
      save.resultSchema.parse(saved);
      assert.match(save.formatResult(saved), /Bring a bucket/);

      bot.entity.position.x = 100;
      bot.game.dimension = "the_nether";
      await clock.advance(2_000);
      // Identical text appends; it does not silently overwrite the original context/location.
      await save.execute(request, {});
      await createNoteSaveAction(noteBot("OtherBot").bot, data).execute(request, {});
      return saved.note;
    })();

    using reopened = storage.open("notes-test");
    const read = createNoteReadAction(reopened, "NoteBot");
    const latest = await read.execute({ n: 1 }, {});
    assert.equal(latest.notes.length, 1);
    assert.equal(latest.notes[0]?.noteId, 2);
    assert.equal(latest.notes[0]?.dimension, "the_nether");
    assert.equal(latest.notes[0]?.position.x, 100);
    assert.equal(latest.notes[0]?.worldAgeTicks, 24040);
    const all = await read.execute({ n: 10 }, {});
    assert.deepEqual(
      all.notes.map((note) => note.noteId),
      [2, 1],
    );
    assert.deepEqual(all.notes[1], first);
    assert.deepEqual(await read.execute({ n: 10 }, {}), all);
    read.resultSchema.parse(all);
    assert.match(read.formatResult(all), /Found lava/);
    assert.equal(reopened.read("SELECT * FROM notes").length, 3);
    assert.match(
      String(
        reopened.read(
          "SELECT description FROM data_dictionary WHERE table_name = 'notes' AND column_name = 'world_age_ticks'",
        )[0]?.description,
      ),
      /Not personal playtime/,
    );
  }
});

test("an unavailable world clock stays unknown and a cancelled save writes nothing", async () => {
  using data = temporaryBotData({ botId: "NoteBot" });
  const save = createNoteSaveAction(noteBotBeforeFirstTimePacket("NoteBot").bot, data);
  const saved = await save.execute(request, {});
  assert.equal(saved.note.worldAgeTicks, null);
  await assert.rejects(save.execute(request, { signal: AbortSignal.abort() }));
  assert.equal(data.read("SELECT * FROM notes").length, 1);
});
