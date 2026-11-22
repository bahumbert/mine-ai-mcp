// Blank-sign filling, guarded clicks and request-owned resume evidence.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, itemOf, listenersAddedSince, type FakeBotOptions } from "../../test-support/fake-bot/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import type { RequestEvidence } from "../../session/request.js";
import { placeSignCheckpointSchema } from "../checkpoint-schemas.js";
import { createPlaceSignAction, placeSignResultSchema } from "./index.js";

const target = new Vec3(2, 64, 0);
const input = { x: 2, y: 64, z: 0, facing: "north", lines: ["Builder", "Hello"], fill_blank: true };

/** Start with a complete sign entity, as sign-edit measured after a setblock. */
function setup(t: TestContext, rate: number, options: FakeBotOptions = {}, request: unknown = input) {
  const clock = createFakeClock({ mode: "mocked" });
  const signs = { ...options.signs };
  const h = createFakeBot({ carried: { oak_sign: 3 }, cells: { "2,64,0": "oak_sign" }, ...options, signs, server: { startAge: 0, ticksPerSecond: rate }, clock });
  const data = temporaryBotData({ closeAfter: t });
  const action = createPlaceSignAction({ bot: h.bot, botData: data, navigation: { navigate: async () => { throw new Error("unexpected route"); } } as never });
  const lifetime = new AbortController();
  let progress!: () => RequestEvidence;
  const run = action.begin(action.parse(request), lifetime.signal, (read) => { progress = read; });
  const block = h.bot.blockAt(target);
  if (block?.name === "oak_sign") {
    block.setSignText("\n\n\n", "\n\n\n");
    h.world.setCell(target, { name: block.name, properties: {}, entity: block.entity! });
  }
  return { ...h, signs, data, action, lifetime, run, checkpoint: () => placeSignCheckpointSchema.parse(progress().checkpoint) };
}

/** Simulate a visible competing edit, preserving both complete sides. */
function setText(h: ReturnType<typeof setup>, front = "", back = "") {
  const block = h.bot.blockAt(target)!;
  block.setSignText(`${front}\n\n\n`, `${back}\n\n\n`);
  h.world.setCell(target, { name: block.name, properties: {}, entity: block.entity! });
}

/** Count only world-changing packets, independently of look and sneak packets. */
function packets(h: ReturnType<typeof setup>, name = "block_place") {
  return h.server.packets.filter((packet) => packet.name === name);
}

/** Every terminal fill leaves its observers gone and the next sign request usable. */
async function finish(h: ReturnType<typeof setup>, added: (event: string) => number) {
  await h.clock.advance(SERVER_CLOCK_STOPPED_MS + 1);
  for (const event of ["signOpen", "blockEntityData", "end", "death", "error"]) assert.equal(added(event), 0, event);
  assert.equal(h.clock.pendingTimers(), 0);
  h.signs.withheld = false;
  h.server.resume();
  const next = h.action.begin(h.action.parse({ ...input, x: 3, fill_blank: false }), new AbortController().signal, () => {});
  assert.equal((await h.clock.settle(next({}), 6_000)).status, "succeeded");
  assert.equal(h.bot.blockAt(target.offset(1, 0, 0))?.getSignText()[0], "Builder\nHello\n\n");
}

for (const rate of [20, 10]) {
  for (const emptyHand of [false, true]) test(`a blank sign is opened by one ${emptyHand ? "empty hand packet" : "held item click"}, confirmed without an item used (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    if (emptyHand) h.bot.setQuickBarSlot(1);
    const added = listenersAddedSince(h.bot);
    h.bot.setControlState("sneak", true);
    const result = await h.clock.settle(h.run({}), 6_000);
    assert.equal(result.status, "succeeded");
    assert.equal(result.sign.placed, false);
    assert.equal(result.sign.confirmed, true);
    assert.deepEqual(result.sign.lines, ["Builder", "Hello", "", ""]);
    assert.equal(h.bot.getControlState("sneak"), false);
    assert.equal(h.inventory.items().find((item) => item.name === "oak_sign")?.count, 3);
    assert.equal(packets(h).length, 1);
    assert.equal(packets(h, "update_sign").length, 1);
    const click = packets(h)[0]!.data as { location: Vec3; direction: number; hand: number; sequence: number };
    assert.deepEqual(click.location, target);
    assert.equal(click.direction, 2);
    assert.equal(click.hand, 0);
    assert.equal(typeof click.sequence, "number");
    assert.equal(h.data.read("SELECT * FROM observed_signs")[0]?.placed_by_bot_id, null);
    assert.ok(placeSignResultSchema.safeParse(result).success);
    assert.equal(h.checkpoint().mode, "fill");
    assert.equal(h.checkpoint().clicked, true);
    assert.ok(h.bot.time.age < 40);
    assert.ok(h.server.gameTime > h.bot.time.age);
    await finish(h, added);
  });

  for (const side of ["front", "back"] as const) test(`text only on the ${side}: cell taken, both sides unchanged, no packet (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    setText(h, side === "front" ? "Other" : "", side === "back" ? "Other" : "");
    const result = await h.clock.settle(h.run({}), 1_000);
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_CELL_TAKEN/);
    assert.deepEqual(result.existing, { block: "oak_sign", front: [side === "front" ? "Other" : "", "", "", ""], back: [side === "back" ? "Other" : "", "", "", ""] });
    assert.equal(packets(h).length + packets(h, "update_sign").length, 0);
    assert.deepEqual(h.bot.blockAt(target)?.getSignText(), [side === "front" ? "Other\n\n\n" : "\n\n\n", side === "back" ? "Other\n\n\n" : "\n\n\n"]);
    await finish(h, added);
  });

  for (const missing of ["entity", "front_text", "back_text"]) test(`no ${missing}: text unknown, no packet or row (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const block = h.bot.blockAt(target)!;
    if (missing === "entity") h.world.setCell(target, "oak_sign");
    else {
      const entity = structuredClone(block.entity!);
      delete (entity.value as Record<string, unknown>)[missing];
      h.world.setCell(target, { name: block.name, properties: {}, entity });
    }
    const result = await h.clock.settle(h.run({}), 1_000);
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_TEXT_UNKNOWN/);
    assert.equal(packets(h).length + packets(h, "update_sign").length, 0);
    assert.deepEqual(h.data.read("SELECT * FROM observed_signs"), []);
    await finish(h, added);
  });

  test(`own region is filled (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    setProtectedRegionsProvider(h.bot, () => [{ regionId: 1, owner: h.bot.username, label: "house", dimension: h.bot.game.dimension, min: target, max: target }]);
    const result = await h.clock.settle(h.run({}), 6_000);
    assert.equal(result.status, "succeeded");
    await finish(h, added);
  });

  test(`a foreign fill cell is refused before approaching it (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    h.bot.entity.position.set(-10, 64, 0);
    setProtectedRegionsProvider(h.bot, () => [{ regionId: 1, owner: "Other", label: "house", dimension: h.bot.game.dimension, min: target, max: target }]);
    const result = await h.clock.settle(h.run({}), 1_000);
    assert.equal(result.status, "failed");
    assert.match("error" in result ? result.error : "", /protected region/);
    assert.equal(packets(h).length + packets(h, "update_sign").length, 0);
    h.bot.entity.position.set(0.5, 64, 0.5);
    await finish(h, added);
  });

  test(`no sign item is carried: filling still succeeds (${rate} tps)`, async (t) => {
    const h = setup(t, rate, { carried: {} });
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const result = await h.clock.settle(h.run({}), 6_000);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.sign.lines, ["Builder", "Hello", "", ""]);
    assert.equal(h.inventory.items().length, 0);
    h.inventory.updateSlot(36, itemOf(h.bot.registry, "oak_sign", 3));
    await finish(h, added);
  });

  for (const when of ["look", "cut"] as const) test(`a foreign region appears during ${when}: rechecked before clicking or resuming (${rate} tps)`, async (t) => {
    let protect = () => {};
    const h = setup(t, rate, when === "look" ? { overrides: { lookAt: async () => protect() } } : {});
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    protect = () => setProtectedRegionsProvider(h.bot, () => [{ regionId: 1, owner: "Other", label: "house", dimension: h.bot.game.dimension, min: target, max: target }]);
    if (when === "cut") {
      const cut = new AbortController();
      const remove = h.server.onPacket("block_place", () => { h.server.stop(); cut.abort(new Error("reflex cut")); });
      await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 1_000), /reflex cut/);
      remove();
      protect();
    }
    const result = await h.clock.settle(h.run({}), 1_000);
    assert.match("error" in result ? result.error : "", /protected region/);
    assert.equal(packets(h).length, when === "look" ? 0 : 1);
    assert.equal(packets(h, "update_sign").length, 0);
    await finish(h, added);
  });

  test(`the entity becomes unknown after the editor: no update_sign (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    h.bot.once("signOpen", () => h.world.setCell(target, "oak_sign"));
    const result = await h.clock.settle(h.run({}), 6_000);
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_TEXT_UNKNOWN/);
    assert.equal(packets(h).length, 1);
    assert.equal(packets(h, "update_sign").length, 0);
    await finish(h, added);
  });

  for (const exit of ["cancel", "death", "disconnect"] as const) test(`${exit} during a suspended fill releases listeners and prevents further packets (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const cut = new AbortController();
    const remove = h.server.onPacket("block_place", () => { h.server.stop(); cut.abort(new Error("reflex cut")); });
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 1_000), /reflex cut/);
    remove();
    if (exit === "cancel") h.lifetime.abort(new Error("request cancelled"));
    else if (exit === "death") h.bot.emit("death");
    else h.bot.emit("end", "disconnect");
    await assert.rejects(h.run({}), /request cancelled|Died|Disconnected/);
    assert.equal(packets(h).length, 1);
    assert.equal(packets(h, "update_sign").length, 0);
    if (exit === "death") h.server.sendPosition(h.bot.entity.position.clone());
    await finish(h, added);
  });

  for (const when of ["look", "editor"] as const) test(`text appears during the ${when}: cell taken before ${when === "look" ? "click" : "write"} (${rate} tps)`, async (t) => {
    let change = () => {};
    const h = setup(t, rate, when === "look" ? { overrides: { lookAt: async () => { change(); } } } : {});
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    change = () => setText(h, "Other");
    if (when === "editor") h.bot.once("signOpen", change);
    const result = await h.clock.settle(h.run({}), 6_000);
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_CELL_TAKEN/);
    assert.equal(packets(h).length, when === "look" ? 0 : 1);
    assert.equal(packets(h, "update_sign").length, 0);
    assert.equal(h.bot.blockAt(target)?.getSignText()[0], "Other\n\n\n");
    await finish(h, added);
  });

  for (const stopped of [false, true]) test(`no editor after the click: NO_EDITOR, one click (${rate} tps, stopped ${stopped})`, async (t) => {
    const h = setup(t, rate, { signs: { withheld: true } });
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const remove = stopped ? h.server.onPacket("block_place", () => h.server.stop()) : () => {};
    const result = await h.clock.settle(h.run({}), SERVER_CLOCK_STOPPED_MS + 100);
    assert.equal(result.status, "failed");
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_NO_EDITOR/);
    assert.equal(packets(h).length, 1);
    assert.equal(packets(h, "update_sign").length, 0);
    assert.equal(h.checkpoint().clicked, true);
    if (stopped) { assert.equal(h.bot.time.age, 0); assert.ok(h.clock.now() >= SERVER_CLOCK_STOPPED_MS); }
    else assert.ok(h.bot.time.age >= 40);
    remove();
    await finish(h, added);
  });

  test(`editor but no text: partial unconfirmed (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const remove = h.server.onPacket("update_sign", () => h.server.stop());
    const result = await h.clock.settle(h.run({}), SERVER_CLOCK_STOPPED_MS + 1_000);
    assert.equal(result.status, "partial");
    assert.equal(result.sign.placed, false);
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_TEXT_UNCONFIRMED/);
    assert.equal(packets(h).length, 1);
    assert.equal(packets(h, "update_sign").length, 1);
    assert.equal(h.bot.time.age, 0);
    remove();
    await finish(h, added);
  });

  for (const resolves of [false, true]) test(`aborted during look: no click even if look ${resolves ? "resolves later" : "never resolves with physics stopped"} (${rate} tps)`, async (t) => {
    let resolveLook!: () => void;
    let looked!: () => void;
    const looking = new Promise<void>((resolve) => { looked = resolve; });
    const look = new Promise<void>((resolve) => { resolveLook = resolve; });
    const h = setup(t, rate, { overrides: { lookAt: () => { looked(); return look; } } });
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const pending = h.run({});
    await h.clock.settle(looking, 1_000);
    h.server.stop();
    h.lifetime.abort(new Error("cancelled during look"));
    await assert.rejects(h.clock.settle(pending, 1_000), /cancelled during look/);
    if (resolves) resolveLook();
    await h.clock.advance(SERVER_CLOCK_STOPPED_MS + 1);
    assert.equal(packets(h).length, 0);
    assert.equal(h.checkpoint().clicked, false);
    // The next action uses the ordinary look, independent of the cancelled promise.
    h.bot.lookAt = async () => {};
    await finish(h, added);
  });

  for (const stage of ["approach", "click_sent", "edit_sent"] as const) {
    const outcomes = stage === "edit_sent" ? ["asked", "blank", "other"] : stage === "click_sent" ? ["editor", "none"] : ["blank"];
    for (const outcome of outcomes) test(`fill cut at ${stage}, ${outcome}: resumes without a second click (${rate} tps)`, async (t) => {
      const h = setup(t, rate, { signs: { withheld: outcome === "none" } });
      using _timers = h.clock.install();
      const added = listenersAddedSince(h.bot);
      const cut = new AbortController();
      let remove = () => {};
      if (stage === "approach") cut.abort(new Error("reflex cut"));
      else remove = h.server.onPacket(stage === "edit_sent" ? "update_sign" : "block_place", () => { h.server.stop(); cut.abort(new Error("reflex cut")); });
      await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
      remove();
      assert.equal(h.checkpoint().phase, stage);
      if (outcome === "asked" || outcome === "editor") {
        const answer = new Promise<void>((resolve) => h.bot.once(outcome === "asked" ? "blockEntityData" : "signOpen", () => resolve()));
        h.server.resume();
        await h.clock.settle(answer, 1_000);
      }
      if (outcome === "other") setText(h, "Other");
      const result = await h.clock.settle(h.run({}), SERVER_CLOCK_STOPPED_MS + 6_000);
      if (outcome === "none") assert.match("error" in result ? result.error : "", /PLACE_SIGN_NO_EDITOR/);
      else if (outcome === "other") assert.match("error" in result ? result.error : "", /PLACE_SIGN_CELL_TAKEN/);
      else if (stage === "edit_sent" && outcome === "blank") assert.equal(result.status, "partial");
      else assert.equal(result.status, "succeeded");
      assert.equal(result.sign.placed, false);
      assert.equal(h.checkpoint().mode, "fill");
      assert.equal(h.checkpoint().clicked, true);
      assert.equal(packets(h).length, 1);
      assert.equal(packets(h, "update_sign").length, outcome === "none" ? 0 : 1);
      await finish(h, added);
    });
  }

  for (const cell of ["stone", "void"]) test(`resume on a replaced ${cell} cell: its code, no packet (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const cut = new AbortController();
    const remove = h.server.onPacket("block_place", () => { h.server.stop(); cut.abort(new Error("reflex cut")); });
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    remove();
    h.world.setCell(target, cell);
    const result = await h.clock.settle(h.run({}), 1_000);
    assert.match("error" in result ? result.error : "", cell === "void" ? /PLACE_SIGN_UNLOADED/ : /PLACE_SIGN_CELL_TAKEN/);
    assert.equal(packets(h).length, 1);
    assert.equal(packets(h, "update_sign").length, 0);
    await finish(h, added);
  });

  test(`place path, edit never came, blank and clicked false: one click then written (${rate} tps)`, async (t) => {
    const h = setup(t, rate, { cells: {} }, { ...input, fill_blank: false });
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const cut = new AbortController();
    const remove = h.server.onPacket("update_sign", () => { h.server.stop(); cut.abort(new Error("reflex cut")); });
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    remove();
    // The first edit had no answer during the cut; reopening is required for the next edit.
    h.server.resume();
    const result = await h.clock.settle(h.run({}), 6_000);
    assert.equal(result.status, "succeeded");
    assert.equal(result.sign.placed, true);
    assert.equal(h.checkpoint().clicked, true);
    assert.equal(packets(h).length, 2);
    assert.equal(h.inventory.items().find((item) => item.name === "oak_sign")?.count, 2);
    assert.equal(h.data.read("SELECT * FROM observed_signs")[0]?.placed_by_bot_id, h.bot.username);
    await finish(h, added);
  });

  test(`place path cut before the editor, no editor: one reopen then partial (${rate} tps)`, async (t) => {
    const h = setup(t, rate, { cells: {}, signs: { withheld: true } }, { ...input, fill_blank: false });
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const cut = new AbortController();
    const remove = h.server.onPacket("block_place", () => cut.abort(new Error("reflex cut")));
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    remove();
    const result = await h.clock.settle(h.run({}), 10_000);
    assert.equal(result.status, "partial");
    assert.equal(result.sign.placed, true);
    assert.equal(h.checkpoint().clicked, true);
    assert.equal(packets(h).length, 2);
    assert.equal(packets(h, "update_sign").length, 0);
    await finish(h, added);
  });
}
