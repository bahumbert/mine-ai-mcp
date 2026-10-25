// The phases a trial reports: the six measured apart, the restore wait, the settle before a client booted ahead joins.
import test from "node:test";
import assert from "node:assert/strict";
import type { ClientProvider } from "mine-labs";
import { ArrangementMutex } from "./arrangement-mutex.ts";
import { executeTrial, type TrialRunner } from "./trial.ts";
import { config, scenario, result, job, runnerOf } from "./trial-fixtures.ts";

test("the six trial phases are measured apart and written as one line to the run's log", async () => {
  const mutex = new ArrangementMutex();
  const lines: string[] = [];
  const holder = await mutex.acquire();
  const phased: TrialRunner = async input => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await input.onArranged();
    await new Promise(resolve => setTimeout(resolve, 30));
    await input.onPrepared();
    input.deferReset(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    await new Promise(resolve => setTimeout(resolve, 40));
    return result("pass");
  };
  const running = executeTrial({ runTrial: phased, config }, job({ mutex, log: line => lines.push(line), scenario: scenario(60) }));
  setTimeout(() => { holder(); }, 25);
  const end = await running;
  const phases = end.phases;
  assert.ok(phases, "a trial that ran reports its phases");
  assert.ok(phases.mutexWaitMs >= 20, `mutexWait ${phases.mutexWaitMs}`);
  assert.ok(phases.arrangeMs >= 15, `arrange ${phases.arrangeMs}`);
  assert.ok(phases.joinMs >= 25, `join ${phases.joinMs}`);
  assert.ok(phases.trialMs >= 35, `trial ${phases.trialMs}`);
  assert.ok(phases.restoreMs >= 10, `restore ${phases.restoreMs}`);
  assert.equal(phases.mutexWaitMs, end.mutexWaitMs);
  const written = lines.filter(text => text.startsWith("phases: "));
  assert.equal(written.length, 1);
  assert.match(written[0]!, /^phases: mutexWait=\d+ arrange=\d+ join=\d+ trial=\d+ restoreWait=\d+ restore=\d+$/u);
});

test("the restore wait is told apart from the restore itself when another lane holds the mutex", async () => {
  const mutex = new ArrangementMutex();
  const runner: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => {});
    const neighbour = await mutex.acquire();
    setTimeout(neighbour, 40);
    return result("pass");
  };
  const end = await executeTrial({ runTrial: runner, config }, job({ mutex, scenario: scenario(60) }));
  assert.ok((end.phases?.restoreWaitMs ?? 0) >= 30, `waited ${end.phases?.restoreWaitMs} ms`);
  assert.ok((end.phases?.restoreMs ?? 99) < (end.phases?.restoreWaitMs ?? 0), `restore took ${end.phases?.restoreMs} ms`);
});

test("a restore the bound gave up on reports the time it had waited or run so far, not 0", async () => {
  const mutex = new ArrangementMutex();
  let neighbour!: () => void;
  const neighbourArranges: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => {});
    neighbour = await mutex.acquire();
    return result("pass");
  };
  const stuckBehindNeighbour = await executeTrial({ runTrial: neighbourArranges, config }, job({ mutex, scenario: scenario(60) }));
  assert.equal(stuckBehindNeighbour.serverSick, true);
  assert.ok((stuckBehindNeighbour.phases?.restoreWaitMs ?? 0) >= 50, `waited ${stuckBehindNeighbour.phases?.restoreWaitMs} ms`);
  assert.equal(stuckBehindNeighbour.phases?.restoreMs, 0, "it never got its turn");
  neighbour();
  const hangs = await executeTrial({ runTrial: runnerOf({ restore: () => new Promise(() => {}) }), config }, job({ scenario: scenario(60) }));
  assert.ok((hangs.phases?.restoreMs ?? 0) >= 50, `ran ${hangs.phases?.restoreMs} ms`);
});

test("a scenario on its own server has no mutex wait and no restore wait in its phases", async () => {
  const end = await executeTrial({ runTrial: runnerOf(), config }, job({ lane: null }));
  assert.equal(end.phases?.mutexWaitMs, 0);
  assert.equal(end.phases?.restoreWaitMs, 0);
});

test("a trial cancelled while it waits for the mutex still reports its phases", async () => {
  const mutex = new ArrangementMutex();
  const holder = await mutex.acquire();
  const cancel = new AbortController();
  const lines: string[] = [];
  const running = executeTrial({ runTrial: runnerOf(), config }, job({ mutex, signal: cancel.signal, log: line => lines.push(line), scenario: scenario(60) }));
  setTimeout(() => cancel.abort("left"), 15);
  const end = await running;
  holder();
  assert.ok((end.phases?.mutexWaitMs ?? 0) >= 10);
  assert.equal(end.phases?.arrangeMs, 0);
  assert.ok(lines.some(text => text.startsWith("phases: ")));
});

// T7h-b: a client booted ahead moves the boot out of `join`: join runs from the first `init`, the settle delay before it is its own phase.
function providedClient(): ClientProvider {
  return () => undefined;
}

test("a runner that asks for its client after the settle delay gets a settle phase, and join runs from that ask to prepared", async () => {
  const lines: string[] = [];
  const asking: TrialRunner = async input => {
    await input.onArranged();
    await new Promise(resolve => setTimeout(resolve, 40));
    input.clientProvider?.({ command: "bun", args: [], env: {} }, "Walker");
    await new Promise(resolve => setTimeout(resolve, 25));
    await input.onPrepared();
    input.deferReset(async () => {});
    return result("pass");
  };
  const end = await executeTrial({ runTrial: asking, config }, job({ log: line => lines.push(line), scenario: scenario(60), clientProvider: providedClient() }));
  const phases = end.phases!;
  assert.ok((phases.settleMs ?? 0) >= 35, `settle ${phases.settleMs}`);
  assert.ok(phases.joinMs >= 20 && phases.joinMs < 38, `join ${phases.joinMs}: the 40 ms before the ask are not in it`);
  assert.match(lines.find(text => text.startsWith("phases: "))!, /^phases: mutexWait=\d+ arrange=\d+ settle=\d+ join=\d+ trial=\d+ restoreWait=\d+ restore=\d+$/u);
});

test("the provider the scheduler gave is the one the runner is handed, and its answer is passed on unchanged", async () => {
  const asked: string[] = [];
  const provider: ClientProvider = (_client, username) => { asked.push(username); return undefined; };
  let handed: ClientProvider | undefined;
  const runner: TrialRunner = async input => {
    handed = input.clientProvider;
    await input.onPrepared();
    input.deferReset(async () => {});
    return result("pass");
  };
  await executeTrial({ runTrial: runner, config }, job({ clientProvider: provider }));
  assert.equal(handed?.({ command: "bun", args: [], env: {} }, "Walker"), undefined);
  assert.deepEqual(asked, ["Walker"]);
});

test("a trial given no provider hands its runner none, and its phases keep today's six", async () => {
  let handed: ClientProvider | undefined = providedClient();
  const runner: TrialRunner = async input => { handed = input.clientProvider; return runnerOf()(input); };
  const lines: string[] = [];
  const end = await executeTrial({ runTrial: runner, config }, job({ log: line => lines.push(line) }));
  assert.equal(handed, undefined);
  assert.equal(end.phases?.settleMs, undefined);
  assert.match(lines.find(text => text.startsWith("phases: "))!, /^phases: mutexWait=\d+ arrange=\d+ join=\d+ trial=\d+ restoreWait=\d+ restore=\d+$/u);
});

test("a provider that throws ends the trial with its message, the lane freed", async () => {
  const mutex = new ArrangementMutex();
  const provider: ClientProvider = () => { throw new Error("scenario client 'bun client-host.ts' failed to boot 2 times in a row"); };
  const runner: TrialRunner = async input => {
    await input.onArranged();
    input.clientProvider?.({ command: "bun", args: [], env: {} }, "Walker");
    return result("pass");
  };
  const end = await executeTrial({ runTrial: runner, config }, job({ mutex, clientProvider: provider }));
  assert.equal(end.result.outcome, "error");
  assert.match(end.result.error ?? "", /trial threw: scenario client 'bun client-host\.ts' failed to boot 2 times in a row/u);
  assert.equal(end.lane, "quarantined");
  (await mutex.acquire())();
});
