import assert from "node:assert/strict";
import test from "node:test";
import { createStack, type StackDeps } from "../stack.ts";
import { stackFixture } from "../stack-test-support.ts";
import { spawnListenerProcess } from "./spawn-listener.ts";

function remoteStack(deps?: Partial<StackDeps>) {
  const fixture = stackFixture((settings) => ({ ...settings, server: { kind: "remote", host: "play.example", port: 25_570 } }));
  const state = createStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, { ...fixture.deps, ...deps });
  state.serverTarget = { host: "play.example", port: 25_570 };
  return { fixture, state };
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const seen: string[] = [];
  for await (const line of lines) seen.push(line);
  return seen;
}

test("the listener child gets the server, the version, its name and the prefix, and a pipe for whispers", () => {
  const { fixture, state } = remoteStack();
  spawnListenerProcess(state);
  const call = fixture.children.spawns.find((entry) => entry.name === "listener")!;
  assert.equal(call.cmd, "C:/MineAI/bun.exe");
  assert.ok(call.args[0]!.replaceAll("\\", "/").endsWith("launcher/src/listener/main.ts"));
  assert.deepEqual(call.args.slice(1), ["--host", "play.example", "--port", "25570", "--version", fixture.manifest.minecraft.version, "--username", "MineAI", "--prefix", "!"]);
  assert.equal(call.options.stdin, "pipe");
});

test("only the child's stdout lines reach the supervisor, in order, and the stream ends when the child exits", async () => {
  const { fixture, state } = remoteStack();
  const process = spawnListenerProcess(state);
  fixture.children.optionsOf("listener").onLine?.('{"kind":"joined"}', "stdout");
  fixture.children.optionsOf("listener").onLine?.("a stderr line", "stderr");
  fixture.children.optionsOf("listener").onLine?.('{"kind":"ended","reason":"x","duplicate":false,"kicked":false}', "stdout");
  fixture.children.crash("listener", 0);
  assert.deepEqual(await collect(process.lines), ['{"kind":"joined"}', '{"kind":"ended","reason":"x","duplicate":false,"kicked":false}']);
});

test("a last line that arrives after the exit event is still delivered (the supervisor must see the kick, not a bare exit)", async () => {
  let drained: () => void = () => {};
  const drain = new Promise<void>((resolve) => (drained = resolve));
  const { fixture, state } = remoteStack({ sleep: () => drain });
  const process = spawnListenerProcess(state);
  const seen = collect(process.lines);
  fixture.children.crash("listener", 0);
  await new Promise((resolve) => setImmediate(resolve));
  const ended = '{"kind":"ended","reason":"multiplayer.disconnect.duplicate_login","duplicate":true,"kicked":true}';
  fixture.children.optionsOf("listener").onLine?.(ended, "stdout");
  drained();
  assert.deepEqual(await seen, [ended]);
});

test("write sends the line to the child's stdin as it is", async () => {
  const { fixture, state } = remoteStack();
  const process = spawnListenerProcess(state);
  process.write('{"kind":"whisper","to":"Tom","message":"hi"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.children.stdinText.get("listener"), '{"kind":"whisper","to":"Tom","message":"hi"}\n');
});

test("stop closes the child's stdin and kills that child by its pid when it does not leave", async () => {
  const { fixture, state } = remoteStack();
  const process = spawnListenerProcess(state);
  await process.stop();
  assert.deepEqual(fixture.killed, [fixture.children.pidOf("listener")]);
});

test("stop of a child that left by itself kills nothing", async () => {
  const { fixture, state } = remoteStack();
  const process = spawnListenerProcess(state);
  fixture.children.crash("listener", 0);
  await process.stop();
  assert.deepEqual(fixture.killed, []);
});

test("with no server to join the spawn says so instead of starting a child", () => {
  const { fixture, state } = remoteStack();
  state.serverTarget = null;
  assert.throws(() => spawnListenerProcess(state), /no Minecraft server to join/u);
  assert.deepEqual(fixture.children.spawns, []);
});
