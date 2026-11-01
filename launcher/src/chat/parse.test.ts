import assert from "node:assert/strict";
import test from "node:test";
import { isCommandLine, parseChatCommand, parseConsoleChat, PLAYER_NAME } from "./parse.ts";

test("PLAYER_NAME accepts 1-16 letters, digits and underscores only", () => {
  for (const name of ["Tom", "a", "Name_With_16char", "x1_Y2"]) assert.ok(PLAYER_NAME.test(name), name);
  for (const name of ["", "Seventeen_chars_x", "Tom Smith", "To>m", "../ayla", "Tom\n"]) assert.ok(!PLAYER_NAME.test(name), JSON.stringify(name));
});

test("isCommandLine: the prefix then bot or bots then a space or the end, any case, leading space allowed", () => {
  for (const text of ["!bots", "!bot", " !Bot start x", "!BOTS", "!bot\tstop x", "  !bots  "]) assert.ok(isCommandLine(text, "!"), text);
});

test("isCommandLine: another bot's commands and chat that only holds the prefix are no command line", () => {
  for (const text of ["!discord", "!botany", "!! creeper", "hi !bots", "bots", "!bot-start x", ""]) assert.ok(!isCommandLine(text, "!"), JSON.stringify(text));
});

test("isCommandLine escapes the prefix for the regular expression", () => {
  assert.ok(isCommandLine(".bots", "."));
  assert.ok(!isCommandLine("xbots", "."), "a dot prefix is no wildcard");
  assert.ok(isCommandLine("$$bot", "$$"));
  assert.ok(isCommandLine("+bots", "+"));
});

test("isCommandLine is not capped in length: the runtime keeps a long command line from the brains too", () => {
  assert.ok(isCommandLine(`!bot start ${"x".repeat(300)}`, "!"));
});

test("parseChatCommand: bots alone lists", () => {
  assert.deepEqual(parseChatCommand("!bots", "!"), { kind: "list" });
  assert.deepEqual(parseChatCommand("  !BoTs  ", "!"), { kind: "list" });
});

test("parseChatCommand: bot start/stop with exactly one name, keywords in any case", () => {
  assert.deepEqual(parseChatCommand("!bot start brea", "!"), { kind: "start", name: "brea" });
  assert.deepEqual(parseChatCommand("!BOT STOP Ayla", "!"), { kind: "stop", name: "Ayla" });
  assert.deepEqual(parseChatCommand("!bot   start\tbrea", "!"), { kind: "start", name: "brea" });
});

test("parseChatCommand: anything else after bot is help, extra words included", () => {
  for (const text of ["!bot", "!bot help", "!bot dance", "!bot start", "!bot start a b", "!bot stop", "!bots now", "!bot list"]) {
    assert.deepEqual(parseChatCommand(text, "!"), { kind: "help" }, text);
  }
});

test("parseChatCommand: null for chat that is no command line", () => {
  for (const text of ["hello", "!discord", "!botany", "hi !bots"]) assert.equal(parseChatCommand(text, "!"), null, text);
});

test("parseChatCommand: a command line over 100 characters is ignored, 100 is read", () => {
  const exactly100 = `!bot start ${"x".repeat(89)}`;
  assert.equal(exactly100.length, 100);
  assert.deepEqual(parseChatCommand(exactly100, "!"), { kind: "start", name: "x".repeat(89) });
  assert.equal(parseChatCommand(`${exactly100}x`, "!"), null);
});

test("parseChatCommand: a multi-character prefix", () => {
  assert.deepEqual(parseChatCommand("@@bot stop brea", "@@"), { kind: "stop", name: "brea" });
  assert.equal(parseChatCommand("!bot stop brea", "@@"), null);
});

// Line shapes as the plan quotes them from the WSL server log (vanilla 1.21.4 console); L records real lines from a live run.
test("parseConsoleChat: a signed-chat line gives sender and text", () => {
  assert.deepEqual(parseConsoleChat("[17:13:28] [Server thread/INFO]: [Not Secure] <Tom> !bots"), { username: "Tom", message: "!bots" });
});

test("parseConsoleChat: the same line without the Not Secure marker", () => {
  assert.deepEqual(parseConsoleChat("[17:13:28] [Server thread/INFO]: <Tom> !bots"), { username: "Tom", message: "!bots" });
});

test("parseConsoleChat: server, action and join lines are no chat", () => {
  for (const line of [
    "[17:13:28] [Server thread/INFO]: [Not Secure] [Server] !bots",
    "[17:13:28] [Server thread/INFO]: * Tom !bots",
    "[17:13:28] [Server thread/INFO]: Tom joined the game",
    "[17:13:28] [Server thread/WARN]: <Tom> !bots",
    "[17:13:28] [Server thread/INFO]: [Not Secure] <Tom>!bots",
    "<Tom> !bots",
  ]) {
    assert.equal(parseConsoleChat(line), null, line);
  }
});

test("parseConsoleChat: a text holding another <name> keeps the first as sender and is no command", () => {
  const chat = parseConsoleChat("[17:13:28] [Server thread/INFO]: [Not Secure] <Tom> <Owner> !bot stop ayla");
  assert.deepEqual(chat, { username: "Tom", message: "<Owner> !bot stop ayla" });
  assert.equal(parseChatCommand(chat!.message, "!"), null);
});

test("parseConsoleChat: a sender name with > or 17 characters is no chat", () => {
  assert.equal(parseConsoleChat("[17:13:28] [Server thread/INFO]: <To>m> !bots"), null);
  assert.equal(parseConsoleChat("[17:13:28] [Server thread/INFO]: <Seventeen_chars_x> !bots"), null);
});
