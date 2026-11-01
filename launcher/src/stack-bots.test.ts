import assert from "node:assert/strict";
import test from "node:test";
import { settingsPath } from "./settings.ts";
import { json, stackFixture, startedFixture, type StackFixture } from "./stack-test-support.ts";
import { describeStack, startBot, startStack, stopBot, type StackState } from "./stack.ts";

for (const [label, settingsFileExists, expected] of [
  [
    "no settings file: the text says there is no file, the path and the way to get one",
    false,
    (root: string) => `There is no settings file at ${settingsPath(root)}, so there is no Minecraft server to join. Run the Mine AI setup again, or mine-ai configure --server-local, then start Mine AI again.`,
  ],
  [
    "a settings file with no server: the text says where to set one",
    true,
    (root: string) => `There is no Minecraft server to join. Set one in ${settingsPath(root)} ("server"), then start Mine AI again.`,
  ],
] as const) {
  test(`startBot on a running stack with no server, ${label}`, async () => {
    const fixture = stackFixture((settings) => ({ ...settings, server: { kind: "none" } }));
    const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, { ...fixture.deps, settingsFileExists: () => settingsFileExists });
    assert.equal(state.phase, "running");
    const outcome = await startBot(state, "ayla");
    assert.deepEqual(outcome, { ok: false, reason: "not-ready", message: expected(fixture.root) });
    assert.deepEqual(fixture.children.spawns, []);
  });
}

/** A promise a test settles by hand, to hold a host's `/health` while the test acts on the stack. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const STOPPED_WHILE_STARTING = /was stopped while it was starting/;
const spawnedFor = (fixture: StackFixture, id: string): string[] => fixture.children.spawns.map((call) => call.name).filter((name) => name.endsWith(`-${id}`));
const botIds = (state: StackState): string[] => describeStack(state).bots.map((bot) => bot.id);

/** A running stack that starts no bot by itself, so each test starts the bots it needs. */
const stackWithoutBots = () => startedFixture((settings) => ({ ...settings, bots: [] }));

/** The host of the first bot (port 25575) answers `/health` only after `ready` opens. */
function holdFirstHost(fixture: StackFixture, ready: { readonly opened: Promise<void> }): void {
  fixture.network.route("GET", "http://127.0.0.1:25575/health", async () => {
    await ready.opened;
    return json({ ok: true });
  });
}

test("a bot stopped while its start waits in the queue is never launched and its start answers that it was stopped", async () => {
  const { fixture, state } = await stackWithoutBots();
  const aylaHealth = gate();
  holdFirstHost(fixture, aylaHealth);
  const ayla = startBot(state, "ayla");
  const brea = startBot(state, "brea");
  assert.equal((await stopBot(state, "brea")).ok, true);
  aylaHealth.open();
  const aylaOutcome = await ayla;
  assert.equal(aylaOutcome.ok, true, aylaOutcome.message);
  const breaOutcome = await brea;
  assert.equal(breaOutcome.ok, false);
  assert.match(breaOutcome.message, STOPPED_WHILE_STARTING);
  assert.deepEqual(spawnedFor(fixture, "brea"), []);
  assert.deepEqual(botIds(state), ["ayla"]);
});

test("a bot stopped during its host's health wait answers that it was stopped, not that the host ended, and gets no brain", async () => {
  const { fixture, state } = await stackWithoutBots();
  fixture.network.route("GET", "http://127.0.0.1:25575/health", async () => {
    await stopBot(state, "brea");
    return json({}, 503);
  });
  const outcome = await startBot(state, "brea");
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, STOPPED_WHILE_STARTING);
  assert.deepEqual(spawnedFor(fixture, "brea"), ["host-brea"]);
  assert.deepEqual(botIds(state), []);
});

test("a bot whose stop is still killing its host when the host turns healthy gets no brain, never goes back to running and is not startable until the stop ends", async () => {
  const { fixture, state } = await stackWithoutBots();
  const hostStopBegun = gate();
  const hostStopHeld = gate();
  let firstHostStop = true;
  const stopChild = fixture.children.stop.bind(fixture.children);
  // A slow kill: the first stop of the host (the player's `stopBot`) is held, the start's own stop of it goes through.
  fixture.children.stop = async (name, options) => {
    if (name === "host-brea" && firstHostStop) {
      firstHostStop = false;
      hostStopBegun.open();
      await hostStopHeld.opened;
    }
    return stopChild(name, options);
  };
  const stopping: ReturnType<typeof stopBot>[] = [];
  fixture.network.route("GET", "http://127.0.0.1:25575/health", async () => {
    stopping.push(stopBot(state, "brea"));
    await hostStopBegun.opened;
    return json({ ok: true });
  });
  const start = startBot(state, "brea");
  const bot = state.bots.get("brea")!;
  const outcome = await start;
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, STOPPED_WHILE_STARTING);
  assert.equal(bot.status, "stopping");
  assert.deepEqual(spawnedFor(fixture, "brea"), ["host-brea"]);
  assert.deepEqual(botIds(state), ["brea"]);
  const restart = await startBot(state, "brea");
  assert.equal(restart.ok, false);
  assert.equal(restart.ok === false && restart.reason, "not-ready");
  assert.match(restart.message, /is stopping/);
  hostStopHeld.open();
  assert.equal((await stopping[0]!).ok, true);
  assert.equal(bot.status, "stopping");
  assert.deepEqual(botIds(state), []);
});

test("a bot stopped while its port is being chosen is never launched", async () => {
  const { fixture, state } = await stackWithoutBots();
  const choosingPort = gate();
  const portChosen = gate();
  const freePort = state.deps.freePort;
  state.deps.freePort = async (start, taken) => {
    choosingPort.open();
    await portChosen.opened;
    return freePort(start, taken);
  };
  const brea = startBot(state, "brea");
  await choosingPort.opened;
  assert.equal((await stopBot(state, "brea")).ok, true);
  portChosen.open();
  const outcome = await brea;
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, STOPPED_WHILE_STARTING);
  assert.deepEqual(spawnedFor(fixture, "brea"), []);
  assert.deepEqual(botIds(state), []);
});

test("a bot stopped while queued starts again during the same wait: one host, one brain, listed in the status", async () => {
  const { fixture, state } = await stackWithoutBots();
  const aylaHealth = gate();
  holdFirstHost(fixture, aylaHealth);
  const ayla = startBot(state, "ayla");
  const firstBrea = startBot(state, "brea");
  assert.equal((await stopBot(state, "brea")).ok, true);
  const secondBrea = startBot(state, "brea");
  aylaHealth.open();
  assert.equal((await ayla).ok, true);
  assert.match((await firstBrea).message, STOPPED_WHILE_STARTING);
  const second = await secondBrea;
  assert.equal(second.ok, true, second.message);
  assert.deepEqual(spawnedFor(fixture, "brea"), ["host-brea", "brain-brea"]);
  assert.deepEqual(botIds(state), ["ayla", "brea"]);
  assert.equal(state.bots.get("brea")!.status, "running");
});
