// T7c: the daemon's trial line, and the bodies a server of its own gives its scenarios.
import test from "node:test";
import assert from "node:assert/strict";
import { fixtureScenario } from "./scenario-fixture.ts";
import { lanePlacement, ownPlacement, SchedulerRig } from "./scheduler-rig.ts";

const TRIAL_LINE = /^trial (\S+) lane (\S+) server (s\d+) queue=(\d+) serverWait=(\d+) mutexWait=(\d+) arrange=(\d+) join=(\d+) trial=(\d+) restoreWait=(\d+) restore=(\d+) hold=(\d+)$/u;

test("each settled lane trial writes one line: where it ran, its wait before admission and for the server, the six phases and its hold", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }]);
  rig.clock += 7_000;
  rig.sample();
  await rig.settle();
  rig.clock += 2_500;
  rig.running[0]!.finish();
  await handle.finished;
  const line = rig.logs.find(candidate => candidate.startsWith("trial "));
  assert.ok(line, `no trial line in ${rig.logs.join(" | ")}`);
  const match = TRIAL_LINE.exec(line);
  assert.ok(match, line);
  assert.deepEqual([match[1], match[2], match[3], match[4], match[12]], ["a", "1", "s1", "7000", "2500"], "queue is admission minus submission, hold is settle minus admission");
});

test("a trial on a server of its own says own, and one that never ran says its phases are none", async () => {
  const rig = new SchedulerRig();
  const own = rig.submit([{ name: "n", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await own.finished;
  assert.match(rig.logs.find(line => line.startsWith("trial n "))!, /^trial n lane own server s1 queue=0 /u);
  rig.factory.failNextStart = true;
  const failing = rig.submit([{ name: "f", placement: lanePlacement("k") }]);
  rig.clock += 5_000;
  rig.sample();
  await rig.settle();
  // The first failed start sends f back to the queue; the second one is its error.
  rig.factory.failNextStart = true;
  rig.clock += 5_000;
  rig.sample();
  await failing.finished;
  assert.match(rig.logs.find(line => line.startsWith("trial f "))!, /^trial f lane 1 server s3 queue=10000 .* phases=none hold=\d+$/u);
});

test("the second scenario on a reusable server of its own logs in under another body: the same server, a name it has not saved", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "n1", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.running[0]!.input.scenario.players.map(player => player.name), ["Actor"], "the first scenario of a server runs as written");
  rig.running[0]!.finish();
  await first.finished;
  const second = rig.submit([{ name: "n2", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  assert.equal(rig.factory.created.length, 1, "the same server");
  assert.deepEqual(rig.running[0]!.input.scenario.players.map(player => player.name), ["ActorL0001"]);
  rig.running[0]!.finish();
  await second.finished;
  const third = rig.submit([{ name: "n3", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  assert.deepEqual(rig.running[0]!.input.scenario.players.map(player => player.name), ["ActorL0002"]);
  rig.running[0]!.finish();
  await third.finished;
});

test("a scenario that cannot be given a fresh body is an error that says why, never run under the old name", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "n1", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await first.finished;
  const base = fixtureScenario(60, "n2");
  const clashing = { ...base, players: ["ABCDEFGHIJKAAAAA", "ABCDEFGHIJKBBBBB"].map(name => ({ ...base.players[0]!, name })) };
  const second = rig.scheduler.submit({
    entries: [{ name: "n2", scenario: clashing, placement: ownPlacement("own:w") }], repeat: 1, maxLanes: null, lock: false, hold: false,
    outDir: "/tmp/out", emit: event => rig.events.push(event),
  });
  rig.sample();
  await rig.settle();
  assert.equal(rig.running.length, 0, "it never started");
  await second.finished;
  const result = rig.events.find(event => event.type === "result" && event.name === "n2");
  assert.equal(result?.type === "result" ? result.outcome : "", "error");
  assert.match(result?.type === "result" ? result.error ?? "" : "", /fresh body.*ABCDEFGHIJKAAAAA.*ABCDEFGHIJKBBBBB/u);
});

test("a server of its own is not reused after a scenario that could not get a fresh body: the next scenario of the key starts another server", async () => {
  const rig = new SchedulerRig();
  const first = rig.submit([{ name: "n1", placement: ownPlacement("own:w") }]);
  rig.sample();
  await rig.settle();
  rig.running[0]!.finish();
  await first.finished;
  const base = fixtureScenario(60, "n2");
  const clashing = { ...base, players: ["BuilderAlpha1", "BuilderAlpha2"].map(name => ({ ...base.players[0]!, name })) };
  const second = rig.scheduler.submit({
    entries: [{ name: "n2", scenario: clashing, placement: ownPlacement("own:w") }], repeat: 1, maxLanes: null, lock: false, hold: false,
    outDir: "/tmp/out", emit: event => rig.events.push(event),
  });
  rig.sample();
  await rig.settle();
  await second.finished;
  assert.deepEqual(rig.pool.reusableSingles("own:w"), [], "the server that refused is retired, not left idle for the next scenario");
});
