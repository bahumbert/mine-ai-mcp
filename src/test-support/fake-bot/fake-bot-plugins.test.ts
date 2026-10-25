/**
 * The fake bot's plugin loader (`lib/plugin_loader.js`, Mineflayer's own code run on the bot), its end (`kick.js`
 * `quit` ending the client, whose `end` the bot re-emits, `loader.js:113`) and its client's uuid.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { plugin as toolPlugin, type Tool } from "mineflayer-tool";
import { Vec3 } from "vec3";
import { createFakeBot } from "./fake-bot.js";

test("loadPlugin runs a plugin on the bot once, and hasPlugin says it is loaded", () => {
  const { bot } = createFakeBot();
  const ran: unknown[] = [];
  const plugin = (injected: unknown) => void ran.push(injected);
  assert.equal(bot.hasPlugin(plugin), false);
  bot.loadPlugin(plugin);
  bot.loadPlugin(plugin);
  assert.deepEqual(ran, [bot]);
  assert.equal(bot.hasPlugin(plugin), true);
});

test("loadPlugins loads each plugin, and a list with a non-function loads none of them", () => {
  const { bot } = createFakeBot();
  const ran: string[] = [];
  const first = () => void ran.push("first");
  const second = () => void ran.push("second");
  assert.throws(() => bot.loadPlugins([first, "not a plugin" as never]), /plugins need to be an array of functions/u);
  assert.deepEqual(ran, []);
  bot.loadPlugins([first, second]);
  assert.deepEqual(ran, ["first", "second"]);
  assert.throws(() => bot.loadPlugin("nope" as never), /plugin needs to be a function/u);
});

test("the real tool plugin installs bot.tool on the fake bot and equips the tool for a block", async () => {
  const { bot } = createFakeBot({ carried: { stone_pickaxe: 1, wooden_shovel: 1 }, cells: { "2,64,0": "stone" } });
  bot.loadPlugin(toolPlugin);
  const { tool } = bot as typeof bot & { tool?: Tool };
  assert.ok(tool, "bot.tool");
  await tool.equipForBlock(bot.blockAt(new Vec3(2, 64, 0))!, {});
  assert.equal(bot.heldItem?.name, "stone_pickaxe");
});

test("quit ends the client, whose end the bot emits with the reason, once", () => {
  const { bot } = createFakeBot();
  const ended: unknown[] = [];
  bot.on("end", (reason) => void ended.push(reason));
  bot.quit("Host test closed");
  bot.quit("again");
  assert.deepEqual(ended, ["Host test closed"]);
});

test("quit without a reason ends with Mineflayer's own 'disconnect.quitting'", () => {
  const { bot } = createFakeBot();
  const ended: unknown[] = [];
  bot.on("end", (reason) => void ended.push(reason));
  bot.quit();
  assert.deepEqual(ended, ["disconnect.quitting"]);
});

test("a disconnect packet reaches the bot as kicked, as kick.js hears it", () => {
  const { bot } = createFakeBot();
  const kicks: unknown[][] = [];
  bot.on("kicked", (reason, loggedIn) => void kicks.push([reason, loggedIn]));
  bot._client.emit("kick_disconnect", { reason: "flying" });
  bot._client.emit("disconnect", { reason: "closed" });
  assert.deepEqual(kicks, [["flying", true], ["closed", false]]);
});

test("the client's uuid is the bot's own player uuid, in the offline form of a server that does not authenticate, and differs per name", () => {
  const first = createFakeBot({ username: "Actor" }).bot;
  const second = createFakeBot({ username: "Other" }).bot;
  const uuid = first._client.uuid;
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(first.players.Actor!.uuid, uuid);
  assert.notEqual(second._client.uuid, uuid);
});
