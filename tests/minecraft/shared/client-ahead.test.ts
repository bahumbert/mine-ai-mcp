import assert from "node:assert/strict";
import test from "node:test";
import { ClientsAhead } from "./client-ahead.ts";
import { loadScenarioServerConfig } from "./config.ts";
import { hostClient, ScriptedClients, type ClientScript } from "./scripted-clients.ts";

const SUBMISSION = 1;

function rig(plan: readonly ClientScript[] = [], env: Record<string, string> = {}) {
  const config = loadScenarioServerConfig(env);
  const clients = new ScriptedClients(plan);
  const logs: string[] = [];
  const changes: number[] = [];
  const ahead = new ClientsAhead({ config, log: line => logs.push(line), spawn: clients.spawn });
  ahead.onChange(() => changes.push(changes.length));
  return { config, clients, ahead, logs, changes };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 20_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Runs `body` on a fresh rig and kills every client it left, so a failed test leaves no process behind. */
async function withRig(plan: readonly ClientScript[], env: Record<string, string>, body: (r: ReturnType<typeof rig>) => Promise<void> | void): Promise<void> {
  const r = rig(plan, env);
  try {
    await body(r);
  } finally {
    for (const submission of [SUBMISSION, 2]) r.ahead.release(submission, "test over");
    await r.clients.stopAll();
  }
}

const OPTIONS = { timeout: 30_000 };

test("a client spawned ahead is booted once its host says so, and the daemon log says how long the boot took", OPTIONS, () => withRig([], {}, async ({ ahead, logs }) => {
  assert.equal(ahead.spawn(SUBMISSION, hostClient()), null);
  assert.equal(ahead.counts(SUBMISSION).booted, 0, "just spawned: not booted yet");
  await until(() => ahead.counts(SUBMISSION).booted === 1, "the booted line");
  assert.match(logs.join("\n"), /client boot s1 bun client-host\.ts drivers\/a\.ts: boot=\d+ ms/u);
}));

test("the lane's environment is not given to a client spawned ahead: init carries it", OPTIONS, () => withRig([], {}, ({ ahead, clients }) => {
  ahead.spawn(SUBMISSION, hostClient("drivers/a.ts", "/w", { MINE_AI_ARENA: '{"x":3,"z":4}' }));
  assert.deepEqual(clients.spawned[0]!.spec.env, {}, "a lane value here would be another trial's: init.env wins, but nothing else may depend on it");
}));

test("a submission boots at most clientsAhead clients and all submissions at most clientsAheadMax", OPTIONS, () => withRig([], { MINE_AI_SCENARIO_CLIENTS_AHEAD: "2", MINE_AI_SCENARIO_CLIENTS_AHEAD_MAX: "3" }, ({ ahead }) => {
  assert.equal(ahead.spawn(SUBMISSION, hostClient()), null);
  assert.equal(ahead.spawn(SUBMISSION, hostClient()), null);
  assert.match(ahead.spawn(SUBMISSION, hostClient()) ?? "", /2 clients of this submission are already booted or booting/u);
  assert.equal(ahead.spawn(2, hostClient()), null, "another submission has its own cap");
  assert.match(ahead.spawn(2, hostClient()) ?? "", /3 clients are already booted or booting in all/u, "the total cap holds for any submission");
}));

test("a client is never given to another submission, nor to a trial of another client command", OPTIONS, () => withRig([], {}, async ({ ahead }) => {
  const clientA = hostClient("drivers/a.ts", "/worktree-a/tests/minecraft");
  ahead.spawn(SUBMISSION, clientA);
  await until(() => ahead.counts(SUBMISSION).booted === 1, "the boot");
  const sameArgsOtherWorktree = ahead.providerFor(SUBMISSION, 7, () => {})(hostClient("drivers/a.ts", "/worktree-b/tests/minecraft"), "Walker");
  assert.equal(sameArgsOtherWorktree, undefined, "same driver, another working directory: a tuple of its own");
  assert.equal(ahead.providerFor(2, 8, () => {})(clientA, "Walker"), undefined, "same command in another submission");
  assert.equal(ahead.counts(SUBMISSION).booted, 1, "still there for its own submission");
  assert.ok(ahead.providerFor(SUBMISSION, 9, () => {})(clientA, "Walker"), "the submission's own trial takes it");
}));

test("a trial takes the client claimed for it first, then a booted one before a booting one, and a taken client is nobody else's", OPTIONS, () => withRig(["hangs", "boots", "boots"], {}, async ({ ahead, clients, logs }) => {
  ahead.spawn(SUBMISSION, hostClient());
  ahead.spawn(SUBMISSION, hostClient());
  ahead.spawn(SUBMISSION, hostClient(), { trial: 5, covered: false });
  await until(() => ahead.counts(SUBMISSION).booted === 2, "two boots (the first hangs)");
  assert.equal(ahead.unclaimedCount(SUBMISSION, hostClient()), 2, "one booting, one booted, unclaimed");
  const trialLog: string[] = [];
  const takenByFive = ahead.providerFor(SUBMISSION, 5, line => trialLog.push(line))(hostClient(), "Walker");
  assert.equal(takenByFive, clients.spawned[2]!.ahead, "the client spawned for trial 5");
  const takenBySix = ahead.providerFor(SUBMISSION, 6, () => {})(hostClient(), "Walker");
  assert.equal(takenBySix, clients.spawned[1]!.ahead, "booted before booting");
  const takenBySeven = ahead.providerFor(SUBMISSION, 7, () => {})(hostClient(), "Walker");
  assert.equal(takenBySeven, clients.spawned[0]!.ahead, "a booting client is still better than a spawn on the spot");
  assert.equal(ahead.providerFor(SUBMISSION, 8, () => {})(hostClient(), "Walker"), undefined, "nothing left: the trial spawns its own client");
  assert.match(trialLog.join("\n"), /client 'Walker' taken from ahead: booted in \d+ ms, waited \d+ ms for its trial/u);
  assert.equal(ahead.waitingCount(), 0);
  assert.equal(logs.filter(line => /failed/u.test(line)).length, 0);
}));

test("a client taken while it still boots says so in its trial's log", OPTIONS, () => withRig(["hangs"], {}, ({ ahead }) => {
  ahead.spawn(SUBMISSION, hostClient());
  const trialLog: string[] = [];
  ahead.providerFor(SUBMISSION, 1, line => trialLog.push(line))(hostClient(), "Walker");
  assert.match(trialLog.join("\n"), /client 'Walker' taken from ahead: still booting after \d+ ms, the trial waits for the rest/u);
}));

test("a client that exits during its boot is a failed boot with its stderr, and two in a row give the tuple up", OPTIONS, () => withRig(["crashes", "crashes"], {}, async ({ ahead, changes, logs }) => {
  const client = hostClient();
  assert.equal(ahead.brokenReason(SUBMISSION, client), null);
  ahead.spawn(SUBMISSION, client);
  await until(() => changes.length >= 1, "the first failed boot");
  assert.equal(ahead.brokenReason(SUBMISSION, client), null, "one failed boot: the next spawn may succeed");
  assert.equal(ahead.spawn(SUBMISSION, client), null);
  await until(() => ahead.brokenReason(SUBMISSION, client) !== null, "the second failed boot");
  const reason = ahead.brokenReason(SUBMISSION, client)!;
  assert.match(reason, /bun client-host\.ts drivers\/a\.ts/u);
  assert.match(reason, /failed to boot 2 times in a row/u);
  assert.match(reason, /exited with code 1/u);
  assert.match(reason, /Cannot find module '\.\/missing-driver\.ts'; at client-host\.ts:7/u, "the boot's stderr, so the trial's error says what to fix");
  assert.match(reason, /no more are started for this submission/u, "and what happens next");
  assert.match(reason, /died or hung before it loaded its driver.*submit again/u, "what really reaches this message: a driver that fails to load is the trial's own error");
  assert.match(ahead.spawn(SUBMISSION, client) ?? "", /failed to boot 2 times in a row/u, "nothing respawned");
  assert.equal(ahead.brokenReason(2, client), null, "another submission may try");
  assert.match(logs.join("\n"), /client boot failed s1 bun client-host\.ts drivers\/a\.ts: exited with code 1/u);
}));

test("a boot that succeeds between two failures clears the count: one transient failure never gives a tuple up", OPTIONS, () => withRig(["crashes", "boots", "crashes"], {}, async ({ ahead, changes }) => {
  const client = hostClient();
  ahead.spawn(SUBMISSION, client);
  await until(() => changes.length >= 1, "the failed boot");
  ahead.spawn(SUBMISSION, client);
  await until(() => ahead.counts(SUBMISSION).booted === 1, "the good boot");
  ahead.spawn(SUBMISSION, client);
  await until(() => changes.length >= 2, "the second failed boot");
  assert.equal(ahead.brokenReason(SUBMISSION, client), null);
}));

test("a client that never says it booted is killed at the boot bound on the wall clock and counts as a failed boot", OPTIONS, () => withRig(["hangs"], { MINE_AI_SCENARIO_CLIENT_BOOT_BOUND_MS: "200" }, async ({ ahead, clients, changes, logs }) => {
  ahead.spawn(SUBMISSION, hostClient());
  await until(() => changes.length >= 1, "the bound");
  assert.equal(clients.spawned[0]!.ahead.child.signalCode, "SIGKILL");
  assert.equal(ahead.waitingCount(), 0);
  assert.match(logs.join("\n"), /did not boot within 0\.2 s/u);
}));

test("a client that boots and then dies while it waits is dropped, not counted as a failed boot", OPTIONS, () => withRig(["boots-then-dies"], {}, async ({ ahead, changes }) => {
  ahead.spawn(SUBMISSION, hostClient());
  await until(() => ahead.counts(SUBMISSION).booted === 1, "the boot");
  await until(() => changes.length >= 1 && ahead.waitingCount() === 0, "the death");
  assert.equal(ahead.brokenReason(SUBMISSION, hostClient()), null);
  assert.equal(ahead.unclaimedCount(SUBMISSION, hostClient()), 0, "nothing dead is handed to a trial");
}));

test("a client that died between the pick and the handover is not handed over: the next one is", OPTIONS, () => withRig(["boots", "boots"], {}, async ({ ahead, clients }) => {
  ahead.spawn(SUBMISSION, hostClient());
  ahead.spawn(SUBMISSION, hostClient());
  await until(() => ahead.counts(SUBMISSION).booted === 2, "two boots");
  clients.spawned[0]!.ahead.child.kill("SIGKILL");
  await until(() => clients.spawned[0]!.ahead.child.signalCode !== null, "the kill");
  const taken = ahead.providerFor(SUBMISSION, 1, () => {})(hostClient(), "Walker");
  assert.equal(taken, clients.spawned[1]!.ahead, "the exit may not have been reported yet: the exit code is read at the pick");
}));

test("a cancelled or ended submission kills every client it still has, claimed or not, and leaves other submissions alone", OPTIONS, () => withRig([], {}, async ({ ahead, clients }) => {
  ahead.spawn(SUBMISSION, hostClient());
  ahead.spawn(SUBMISSION, hostClient(), { trial: 4, covered: true });
  ahead.spawn(2, hostClient());
  await until(() => ahead.counts(SUBMISSION).booted === 2, "the boots");
  assert.equal(ahead.release(SUBMISSION, "cancelled"), 2);
  await Promise.all(clients.spawned.slice(0, 2).map(({ ahead: client }) => client.closed));
  assert.deepEqual(clients.spawned.slice(0, 2).map(({ ahead: client }) => client.child.signalCode), ["SIGKILL", "SIGKILL"]);
  assert.equal(clients.spawned[2]!.ahead.child.exitCode, null);
  assert.equal(ahead.waitingCount(), 1);
  assert.equal(ahead.release(SUBMISSION, "again"), 0, "a second release has nothing to kill");
}));

test("a trial that ends without taking its claimed client returns it to the submission's spares, still waiting for init", OPTIONS, () => withRig([], {}, async ({ ahead, clients }) => {
  ahead.spawn(SUBMISSION, hostClient(), { trial: 4, covered: true });
  await until(() => ahead.counts(SUBMISSION).booted === 1, "the boot");
  assert.equal(ahead.unclaimedCount(SUBMISSION, hostClient()), 0, "claimed by trial 4");
  ahead.trialEnded(4);
  assert.equal(ahead.unclaimedCount(SUBMISSION, hostClient()), 1);
  assert.equal(ahead.providerFor(SUBMISSION, 5, () => {})(hostClient(), "Walker"), clients.spawned[0]!.ahead, "the next trial of the submission takes it");
  ahead.trialEnded(4);
}));

test("claiming takes the booted clients of the tuple for a trial, as many as it has players and no more", OPTIONS, () => withRig([], {}, ({ ahead }) => {
  for (let n = 0; n < 3; n++) ahead.spawn(SUBMISSION, hostClient());
  assert.equal(ahead.claim(SUBMISSION, 1, hostClient(), 2), 2);
  assert.equal(ahead.claim(SUBMISSION, 2, hostClient(), 2), 1, "one left for the second trial");
  assert.equal(ahead.claim(SUBMISSION, 3, hostClient("drivers/other.ts"), 1), 0, "another driver, nothing booted for it");
}));

test("a client spawned for a queued trial reserves its booted size while it grows, one spawned for an admitted trial reserves nothing of its own", OPTIONS, () => withRig([], {}, ({ ahead, config }) => {
  ahead.spawn(SUBMISSION, hostClient());
  ahead.spawn(SUBMISSION, hostClient());
  ahead.spawn(SUBMISSION, hostClient(), { trial: 9, covered: true });
  const spawnedAt = Date.now();
  assert.equal(ahead.youngMb(spawnedAt), 2 * config.clientBootedMemMb, "the covered one is part of its trial's whole client");
  assert.equal(ahead.youngMb(spawnedAt + config.clientRampMs + 1_000), 0, "after the ramp it is in MemAvailable");
}));

test("when a tuple is given up, the clients still waiting for it are killed: every trial of it fails the same way, none gets a client", OPTIONS, () => withRig(["crashes", "hangs", "crashes"], {}, async ({ ahead, clients, changes }) => {
  const client = hostClient();
  ahead.spawn(SUBMISSION, client);
  await until(() => changes.length >= 1, "the first failed boot");
  ahead.spawn(SUBMISSION, client);
  ahead.spawn(SUBMISSION, client);
  await until(() => ahead.brokenReason(SUBMISSION, client) !== null, "the tuple given up");
  await clients.spawned[1]!.ahead.closed;
  assert.equal(clients.spawned[1]!.ahead.child.signalCode, "SIGKILL", "the client that was still booting is no use to a submission whose trials fail");
  assert.equal(ahead.waitingCount(SUBMISSION), 0);
  assert.match(ahead.spawn(SUBMISSION, client) ?? "", /failed to boot 2 times in a row/u);
  assert.throws(() => ahead.providerFor(SUBMISSION, 1, () => {})(client, "Walker"), /failed to boot 2 times in a row/u);
  assert.equal(ahead.providerFor(2, 3, () => {})(client, "Walker"), undefined, "a submission that has not failed spawns on the spot as before");
}));

test("a client taken while it still boots does not clear the failed boots counted before it", OPTIONS, () => withRig(["crashes", "hangs", "crashes"], {}, async ({ ahead, changes }) => {
  const client = hostClient();
  ahead.spawn(SUBMISSION, client);
  await until(() => changes.length >= 1, "the first failed boot");
  ahead.spawn(SUBMISSION, client);
  assert.ok(ahead.providerFor(SUBMISSION, 1, () => {})(client, "Walker"), "taken while it boots");
  ahead.spawn(SUBMISSION, client);
  await until(() => ahead.brokenReason(SUBMISSION, client) !== null, "the second failed boot counts with the first");
}));
