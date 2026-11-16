/** Registry-ordered family information and input validation. */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { familyIndexOf } from "../../world/item-families.js";
import { parseViewItemFamilyRequest, viewItemFamily } from "./index.js";

test("lists the family in registry order", async () => {
  const { bot } = createFakeBot();
  const result = await viewItemFamily(bot, parseViewItemFamilyRequest({ family: "sign" }), {});
  assert.deepEqual(result, { status: "succeeded", family: "sign", members: bot.registry.itemsArray.filter((item) => familyIndexOf(bot).itemFamilies(item.name).includes("sign")).map((item) => item.name) });
});

test("an unknown family is refused", () => {
  assert.throws(() => parseViewItemFamilyRequest({ family: "unknown" }));
});
