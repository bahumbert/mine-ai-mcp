// A missing template is built by the daemon while nothing else runs (spec 2026-10-30-scenario-clients-ext4 D11, plan P3b): when it starts, what waits for it, what it costs the ledger, how it fails.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lanePlacement, SchedulerRig } from "./scheduler-rig.ts";
import { ScriptedClients } from "./scripted-clients.ts";
import { BUILD_JAVA_PID, BUILD_KEY, BUILD_VERSION, TemplateBuildRig } from "./template-build-rig.ts";
import { BUILD_SERVER_HEAP_MB } from "./world-template.ts";

async function withRigs(body: (builds: TemplateBuildRig, rig: SchedulerRig) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const builds = new TemplateBuildRig(env);
  const rig = new SchedulerRig(env, { templateBuilds: builds.builds });
  try {
    await body(builds, rig);
  } finally {
    await builds.shutDown();
    builds.dispose();
  }
}

const builtDir = (builds: TemplateBuildRig, key = BUILD_KEY): string => join(builds.storeDir, key);

test("a trial submitted during a build waits for it, the wait line names the build, and the trial starts the moment the build ends", async () => {
  await withRigs(async (builds, rig) => {
    rig.sample();
    await builds.startIfDue();
    const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }]);
    rig.clock += 5_000;
    rig.sample();
    await rig.settle();
    assert.deepEqual(rig.runningNames(), [], "held");
    assert.match(rig.scheduler.waitReport(handle.id) ?? "", /^a waits: world template build of 1\.21\.4 is running/u);
    assert.equal(rig.scheduler.sampleReport()?.held["template-build"], 1);
    builds.calls[0]!.finish({ ok: true, dir: builtDir(builds) });
    await rig.settle();
    assert.deepEqual(rig.runningNames(), ["a"], "no sample needed");
    assert.equal(builds.builds.active, null);
  });
});

test("the build's server counts in the ledger as one busy server: its heap and overhead, less what it holds, until it ends", async () => {
  await withRigs(async (builds, rig) => {
    rig.sample();
    const free = rig.scheduler.sampleReport()!.ledgerMb;
    await builds.startIfDue();
    rig.sample();
    assert.equal(rig.scheduler.sampleReport()!.ledgerMb, free - BUILD_SERVER_HEAP_MB - builds.config.serverOverheadMb, "just started, nothing resident yet");
    await builds.calls[0]!.startServer();
    await builds.builds.sampleResident(async pid => (pid === BUILD_JAVA_PID ? 2_000 : 0));
    rig.sample();
    assert.equal(rig.scheduler.sampleReport()!.ledgerMb, free - (BUILD_SERVER_HEAP_MB + builds.config.serverOverheadMb - 2_000), "its resident size is read from its java pid");
    builds.calls[0]!.finish({ ok: false, reason: "x", bound: true });
    await rig.settle();
    rig.sample();
    assert.equal(rig.scheduler.sampleReport()!.ledgerMb, free);
  });
});

test("a build starts only when the ledger covers its heap and the margin; it says so once and starts at the first sample with room", async () => {
  await withRigs(async builds => {
    const needed = BUILD_SERVER_HEAP_MB + builds.config.serverMemMarginMb;
    await builds.startIfDue({ ledgerMb: needed - 1 });
    await builds.startIfDue({ ledgerMb: needed - 1 });
    assert.equal(builds.calls.length, 0);
    assert.equal(builds.lines.filter(line => /world template build waits: memory ledger/u.test(line)).length, 1, "said once");
    await builds.startIfDue({ ledgerMb: needed });
    assert.equal(builds.calls.length, 1);
  });
});

test("a build that is running starts no other: a second version waits for the next idle sample after the first ended", async () => {
  await withRigs(async builds => {
    builds.status.push({ version: "1.20.4", key: "key-1-20-4", boxes: [], present: false });
    await builds.startIfDue();
    await builds.startIfDue();
    assert.equal(builds.calls.length, 1, "one at a time");
    builds.calls[0]!.finish({ ok: true, dir: builtDir(builds) });
    await builds.settle();
    assert.equal(builds.calls.length, 1, "no start without a sample");
    builds.status[0]!.present = true;
    await builds.startIfDue();
    assert.equal(builds.calls.length, 2);
    assert.equal(builds.calls[1]!.options.version, "1.20.4");
  });
});

const CUT_BY_BOUND = { ok: false, reason: "save: the 180000 ms bound ran out", bound: true } as const;
const OTHER_KEY_DIR = "another-key";
const RESULTS: readonly { readonly name: string; readonly result: (builds: TemplateBuildRig) => Parameters<TemplateBuildRig["calls"][number]["finish"]>[0]; readonly retried: boolean; readonly line: RegExp }[] = [
  {
    name: "a failure of its own is remembered for the daemon's life",
    result: () => ({ ok: false, reason: "only 10 of 35590 chunks saved", bound: false }), retried: false,
    line: /world template key-1-21-4 build failed: only 10 of 35590 chunks saved \(not tried again until the daemon restarts\)/u,
  },
  {
    name: "a build cut by its bound is tried again at the next idle sample",
    result: () => CUT_BY_BOUND, retried: true,
    line: /world template key-1-21-4 build cut by its bound: save: the 180000 ms bound ran out \(tried again at the next idle sample\)/u,
  },
  {
    name: "a result stored under another key than the daemon computed is a failure: the daemon would never find that template",
    result: builds => ({ ok: true, dir: builtDir(builds, OTHER_KEY_DIR) }), retried: false,
    line: /built under key another-key, the daemon computed key-1-21-4/u,
  },
];
for (const { name, result, retried, line } of RESULTS) {
  test(`${name}: the log says why`, async () => {
    await withRigs(async builds => {
      await builds.startIfDue();
      builds.calls[0]!.finish(result(builds));
      await builds.settle();
      assert.match(builds.lines.join("\n"), line);
      await builds.startIfDue();
      await builds.startIfDue();
      assert.equal(builds.calls.length, retried ? 2 : 1, retried ? "one more build, at the next idle sample" : "not built again");
    });
  });
}

test("a bound-cut build is tried at most 3 times, then not again until the daemon restarts; the last cut says so, and the next version is built", async () => {
  await withRigs(async builds => {
    builds.status.push({ version: "1.20.4", key: "key-1-20-4", boxes: [], present: false });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await builds.startIfDue();
      assert.equal(builds.calls.length, attempt, `try ${attempt} starts at an idle sample`);
      builds.calls[attempt - 1]!.finish(CUT_BY_BOUND);
      await builds.settle();
    }
    const cutLines = builds.lines.filter(line => /build cut by its bound/u.test(line));
    assert.equal(cutLines.length, 3);
    assert.match(cutLines[1]!, /\(tried again at the next idle sample\)$/u);
    assert.match(cutLines[2]!, /world template key-1-21-4 build cut by its bound 3 times: save: the 180000 ms bound ran out \(not tried again until the daemon restarts\)$/u);
    assert.deepEqual(builds.calls.map(call => call.options.version), [BUILD_VERSION, BUILD_VERSION, BUILD_VERSION], "the cuts of the first version took no try of the second");
    await builds.startIfDue();
    assert.equal(builds.calls.length, 4, "the first version is given up: the next missing one is built");
    assert.equal(builds.calls[3]!.options.version, "1.20.4");
  });
});

test("a port pair that cannot be leased is no build failure: it is tried again at the next idle sample, says why, and shares the 3 tries with the bound cuts", async () => {
  await withRigs(async builds => {
    const noPair = new Error("no free port pair");
    builds.leaseError = noPair;
    await builds.startIfDue();
    await builds.settle();
    assert.equal(builds.calls.length, 0, "no build ran");
    assert.equal(builds.builds.active, null, "nothing holds the trials back");
    assert.match(builds.lines.join("\n"), /world template key-1-21-4 build not started: no free port pair \(tried again at the next idle sample\)/u);
    assert.doesNotMatch(builds.lines.join("\n"), /build failed/u);
    builds.leaseError = null;
    await builds.startIfDue();
    assert.equal(builds.calls.length, 1, "built once a pair is free");
    builds.calls[0]!.finish(CUT_BY_BOUND);
    await builds.settle();
    assert.deepEqual(builds.released, builds.leased, "only a leased pair is given back");
    builds.leaseError = noPair;
    await builds.startIfDue();
    await builds.settle();
    assert.match(builds.lines.at(-1) ?? "", /build not started, 3 tries used \(bound cuts and starts without a port pair\): no free port pair \(not tried again until the daemon restarts\)$/u, "the count names no kind when the tries were of two");
    builds.leaseError = null;
    await builds.startIfDue();
    assert.equal(builds.calls.length, 1, "given up");
  });
});

test("nothing missing, nothing to build", async () => {
  await withRigs(async builds => {
    builds.status[0]!.present = true;
    await builds.startIfDue();
    assert.equal(builds.calls.length, 0);
    assert.equal(builds.builds.active, null);
  });
});

test("a build that throws is a remembered failure, not an unhandled rejection, and the trials it held start", async () => {
  const unhandled: unknown[] = [];
  const watch = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", watch);
  try {
    await withRigs(async (builds, rig) => {
      rig.sample();
      builds.buildError = new Error("spawn exploded");
      await builds.startIfDue();
      await rig.settle();
      assert.equal(builds.builds.active, null, "the build ended");
      rig.submit([{ name: "b", placement: lanePlacement("k") }]);
      rig.sample();
      await rig.settle();
      assert.deepEqual(rig.runningNames(), ["b"], "its trial is not held by a build that is gone");
      await builds.startIfDue();
      assert.equal(builds.calls.length, 0);
      assert.match(builds.lines.join("\n"), /world template key-1-21-4 build failed: spawn exploded \(not tried again until the daemon restarts\)/u);
    });
  } finally {
    process.off("unhandledRejection", watch);
  }
  assert.deepEqual(unhandled, []);
});

test("the build is given the version, the bound and the store; its server is registered like any server the daemon starts, on a port pair the daemon leased, both given back at its end", async () => {
  await withRigs(async builds => {
    await builds.startIfDue();
    assert.equal(builds.calls[0]!.options.version, BUILD_VERSION);
    assert.equal(builds.calls[0]!.options.boundMs, builds.config.templateBuildBoundMs);
    assert.equal(builds.calls[0]!.options.cacheDir, builds.config.templateDir);
    assert.deepEqual(builds.preferPorts, builds.leased, "the build server asks for the leased pair");
    const server = await builds.calls[0]!.startServer();
    assert.deepEqual(builds.pidFile, [{ pid: BUILD_JAVA_PID, root: join(builds.storeDir, "build.tmp-1") }]);
    await server.stop();
    assert.deepEqual(builds.pidFile, [], "removed at its stop");
    builds.calls[0]!.finish({ ok: true, dir: builtDir(builds) });
    await builds.settle();
    assert.deepEqual(builds.released, builds.leased);
  });
});

test("a build server whose java pid is not found still runs and is still counted: it holds its whole growth", async () => {
  await withRigs(async (builds, rig) => {
    builds.javaPid = null;
    rig.sample();
    const free = rig.scheduler.sampleReport()!.ledgerMb;
    await builds.startIfDue();
    await builds.calls[0]!.startServer();
    assert.deepEqual(builds.pidFile, []);
    await builds.builds.sampleResident(async () => 3_000);
    rig.sample();
    assert.equal(rig.scheduler.sampleReport()!.ledgerMb, free - BUILD_SERVER_HEAP_MB - builds.config.serverOverheadMb);
  });
});

test("a server start that comes after the stop is refused, the build ends, and no build starts afterwards (the daemon's own stop of a running one: daemon.test.ts)", async () => {
  await withRigs(async builds => {
    await builds.startIfDue();
    const stopping = builds.builds.stop();
    await assert.rejects(builds.calls[0]!.startServer(), /daemon is stopping/u);
    builds.calls[0]!.finish({ ok: false, reason: "build server did not start", bound: false });
    await stopping;
    assert.equal(builds.servers.length, 0, "nothing was started");
    assert.equal(builds.builds.active, null);
    await builds.startIfDue();
    assert.equal(builds.calls.length, 1, "stopped for good");
  });
});

test("a submission that arrives while the key is being computed prevents the build: idle is checked again after the wait", async () => {
  await withRigs(async builds => {
    let idle = true;
    let open!: () => void;
    builds.statusGate = new Promise<void>(resolve => { open = resolve; });
    const starting = builds.startIfDue({ idle: () => idle });
    idle = false;
    open();
    await starting;
    assert.equal(builds.calls.length, 0);
    assert.equal(builds.builds.active, null);
  });
});

test("the first idle sample with a key known prunes templates unused for a week, once; a current key stays", async () => {
  await withRigs(async builds => {
    const longAgo = (Date.now() - 30 * 86_400_000) / 1000;
    const makeOld = (name: string): string => {
      const dir = join(builds.storeDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "template.json"), "{}\n");
      utimesSync(join(dir, "template.json"), longAgo, longAgo);
      return dir;
    };
    const stale = makeOld("stale-key");
    const current = makeOld(BUILD_KEY);
    builds.status[0]!.present = true;
    await builds.startIfDue();
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(current), true, "the current key is never pruned");
    assert.match(builds.lines.join("\n"), /world template prune: removed stale-key/u);
    makeOld("stale-key");
    await builds.startIfDue();
    assert.equal(existsSync(stale), true, "once per daemon");
  });
});

test("trials held by a build boot no client ahead: they would idle for the whole build, beside a build that runs alone", async () => {
  const builds = new TemplateBuildRig();
  const clients = new ScriptedClients([]);
  const rig = new SchedulerRig({}, { clients, templateBuilds: builds.builds });
  try {
    rig.sample();
    await builds.startIfDue();
    rig.submit(["a", "b", "c"].map(name => ({ name, placement: lanePlacement("k") })));
    rig.clock += 5_000;
    rig.sample();
    assert.deepEqual(rig.runningNames(), []);
    assert.equal(clients.spawned.length, 0);
  } finally {
    rig.scheduler.cancelAll("test over");
    await clients.stopAll();
    await builds.shutDown();
    builds.dispose();
  }
});

test("a pid file that cannot be written stops the build server it was about to register: nothing runs outside the pid file", async () => {
  await withRigs(async builds => {
    builds.pidFileError = new Error("disk full");
    await builds.startIfDue();
    await assert.rejects(builds.calls[0]!.startServer(), /disk full/u);
    assert.equal(builds.servers[0]!.stopped, true);
  });
});
