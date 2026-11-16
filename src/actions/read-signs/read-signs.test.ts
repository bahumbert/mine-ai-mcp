// Reading signs and recording only complete observations.
import test from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { recordOwnSign } from "../../bot-data/sign-observations.js";
import { parseReadSignsRequest, readSigns, signReadingSchema } from "./index.js";

const cell = new Vec3(1, 64, 0);
const request = () => parseReadSignsRequest({ x: 1, y: 64, z: 0 });
const rows = (data: ReturnType<typeof temporaryBotData>) => data.read("SELECT * FROM observed_signs");

test("cell mode reads front and back", (t) => {
  const { bot, world } = createFakeBot({ cells: { "1,64,0": "oak_sign" } });
  const sign = bot.blockAt(cell)!;
  sign.setSignText("hello\nworld\n\n", "back\n\n\n");
  world.setCell(cell, { name: "oak_sign", properties: {}, entity: sign.entity! });
  const data = temporaryBotData({ closeAfter: t });
  const result = readSigns(bot, data, request());
  assert.deepEqual(result.signs[0], { position: { x: 1, y: 64, z: 0 }, block: "oak_sign", known: true, front: ["hello", "world", "", ""], back: ["back", "", "", ""] });
  assert.equal(rows(data).length, 1);
});

test("cell with no sign: empty and its row forgotten", (t) => {
  const { bot } = createFakeBot({ cells: { "1,64,0": "stone" } });
  const data = temporaryBotData({ closeAfter: t });
  recordOwnSign(data, "Builder", { dimension: bot.game.dimension, position: cell, block: "oak_sign", front: ["", "", "", ""], back: ["", "", "", ""] });
  assert.deepEqual(readSigns(bot, data, request()).signs, []);
  assert.deepEqual(rows(data), []);
});

test("area mode nearest first, limit kept", (t) => {
  const { bot } = createFakeBot({ position: new Vec3(0, 64, 0), cells: { "1,64,0": "oak_sign", "3,64,0": "spruce_sign", "5,64,0": "oak_wall_sign" } });
  const data = temporaryBotData({ closeAfter: t });
  const result = readSigns(bot, data, parseReadSignsRequest({ limit: 2, max_distance: 4 }));
  assert.deepEqual(result.signs.map((sign) => sign.position.x), [1, 3]);
});

test("unloaded cell refused", (t) => {
  const { bot } = createFakeBot();
  const data = temporaryBotData({ closeAfter: t });
  const result = readSigns(bot, data, parseReadSignsRequest({ x: 10000, y: 64, z: 0 }));
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /READ_SIGNS_UNLOADED/);
});

test("a read after a text change clears the placer", (t) => {
  const { bot, world } = createFakeBot({ cells: { "1,64,0": "oak_sign" } });
  const sign = bot.blockAt(cell)!;
  sign.setSignText("new\n\n\n", "\n\n\n");
  world.setCell(cell, { name: "oak_sign", properties: {}, entity: sign.entity! });
  const data = temporaryBotData({ closeAfter: t });
  recordOwnSign(data, "Builder", { dimension: bot.game.dimension, position: cell, block: "oak_sign", front: ["old", "", "", ""], back: ["", "", "", ""] });
  readSigns(bot, data, request());
  assert.equal(rows(data)[0]?.placed_by_bot_id, null);
});

test("incomplete sign entities read known false without writing a row", (t) => {
  for (const missing of ["entity", "back"] as const) {
    const { bot, world } = createFakeBot({ cells: { "1,64,0": "oak_sign" } });
    if (missing === "back") {
      const sign = bot.blockAt(cell)!;
      sign.setSignText("hello\n\n\n", "\n\n\n");
      delete sign.entity!.value.back_text;
      world.setCell(cell, { name: "oak_sign", properties: {}, entity: sign.entity! });
    }
    const data = temporaryBotData({ closeAfter: t });
    assert.equal(readSigns(bot, data, request()).signs[0]?.known, false);
    assert.deepEqual(rows(data), []);
  }
});

test("coordinate and scan bounds are validated", () => {
  for (const input of [{ x: 1 }, { x: 1, y: 2 }, { x: 1.5, y: 2, z: 3 }, { x: Number.MAX_SAFE_INTEGER + 1, y: 2, z: 3 }, { max_distance: 0 }, { max_distance: 65 }, { limit: 0 }, { limit: 33 }]) assert.throws(() => parseReadSignsRequest(input));
  assert.doesNotThrow(() => parseReadSignsRequest({ max_distance: 1, limit: 1 }));
  assert.doesNotThrow(() => parseReadSignsRequest({ max_distance: 64, limit: 32 }));
  assert.doesNotThrow(() => parseReadSignsRequest({ x: Number.MAX_SAFE_INTEGER, y: 2, z: 3 }));
});

test("result requires four lines on each side", () => {
  const reading = { position: { x: 1, y: 64, z: 0 }, block: "oak_sign", known: true, front: ["", "", "", ""], back: ["", "", "", ""] };
  assert.equal(signReadingSchema.safeParse(reading).success, true);
  for (const side of ["front", "back"] as const) for (const length of [3, 5]) {
    assert.equal(signReadingSchema.safeParse({ ...reading, [side]: Array(length).fill("") }).success, false);
  }
});
