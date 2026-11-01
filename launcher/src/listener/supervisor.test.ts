import assert from "node:assert/strict";
import test from "node:test";
import { ListenerSupervisor, type ListenerCommand, type ListenerProcess } from "./supervisor.ts";

/** A listener process whose stdout lines the test feeds one by one; `end()` closes stdout like an exiting child. */
class FakeProcess implements ListenerProcess {
  readonly written: string[] = [];
  stopCalls = 0;
  /** While set, `stop()` waits for it: a child that takes time to end. */
  stopGate: Promise<void> | null = null;
  readonly exited: Promise<unknown>;
  readonly lines: AsyncIterable<string>;
  private readonly queue: string[] = [];
  private closed = false;
  private wake: (() => void) | null = null;
  private resolveExited: (() => void) | null = null;

  constructor() {
    this.exited = new Promise<void>((resolve) => (this.resolveExited = resolve));
    this.lines = this.read();
  }

  private async *read(): AsyncGenerator<string> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) yield next;
      else if (this.closed) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  send(event: object): void {
    this.queue.push(JSON.stringify(event));
    this.wake?.();
  }

  end(): void {
    this.closed = true;
    this.wake?.();
    this.resolveExited?.();
  }

  write(line: string): void {
    this.written.push(line);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopGate;
    this.end();
  }
}

class Harness {
  readonly processes: FakeProcess[] = [];
  readonly said: string[] = [];
  readonly commands: ListenerCommand[] = [];
  readonly sleeps: { ms: number; wake(): void }[] = [];
  readonly supervisor: ListenerSupervisor;

  /** `failSpawns`: the first n spawns throw (`Children.spawn` throws when the name still runs); `onCommandThrowsOnce`: the first command handler call throws. */
  constructor(faults: { failSpawns?: number; onCommandThrowsOnce?: boolean; retryFirstMs?: number } = {}) {
    let spawnsToFail = faults.failSpawns ?? 0;
    let commandThrows = faults.onCommandThrowsOnce ?? false;
    this.supervisor = new ListenerSupervisor({
      spawn: () => {
        if (spawnsToFail > 0) {
          spawnsToFail -= 1;
          throw new Error("spawn refused");
        }
        const process = new FakeProcess();
        this.processes.push(process);
        return process;
      },
      now: () => 0,
      sleep: (ms) => new Promise<void>((resolve) => this.sleeps.push({ ms, wake: resolve })),
      say: (line) => this.said.push(line),
      onCommand: (line) => {
        this.commands.push(line);
        if (commandThrows) {
          commandThrows = false;
          throw new Error("bug in onCommand");
        }
      },
      name: "MineAI",
      ...(faults.retryFirstMs === undefined ? {} : { retryFirstMs: faults.retryFirstMs }),
    });
  }

  get current(): FakeProcess {
    const last = this.processes.at(-1);
    assert.ok(last, "no process was spawned");
    return last;
  }

  /** Lets the supervisor's pending promise chains run. */
  async settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** The nth sleep resolves, as if its time had passed. */
  async wakeSleep(index: number): Promise<void> {
    this.sleeps[index]?.wake();
    await this.settle();
  }

  async join(): Promise<void> {
    this.current.send({ kind: "joined" });
    await this.settle();
  }

  async end(event: object): Promise<void> {
    this.current.send({ kind: "ended", ...event });
    this.current.end();
    await this.settle();
  }
}

const PLAIN_END = { reason: "socketClosed", duplicate: false, kicked: false };

test("wanting the listener spawns one process, and wanting it twice spawns no second", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  h.supervisor.setWanted(true);
  await h.settle();
  assert.equal(h.processes.length, 1);
});

test("joined makes isJoined true and says so once", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  assert.equal(h.supervisor.isJoined(), false);
  await h.join();
  assert.equal(h.supervisor.isJoined(), true);
  assert.deepEqual(h.said, ["Listening for chat commands as MineAI."]);
});

test("command lines from the process reach onCommand, bad lines are skipped", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  h.current.send({ kind: "command", username: "Tom", channel: "chat", message: "!bots" });
  h.current.send({ kind: "command", username: "Tom", channel: "shout", message: "!bots" });
  h.current.send({ kind: "command", username: "Tom" });
  await h.settle();
  assert.deepEqual(h.commands, [{ username: "Tom", channel: "chat", message: "!bots" }]);
});

test("leave on unwant: the process is stopped, not respawned", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  await h.join();
  const old = h.current;
  h.supervisor.setWanted(false);
  await h.settle();
  assert.equal(old.stopCalls >= 1, true);
  assert.equal(h.supervisor.isJoined(), false);
  assert.equal(h.sleeps.length, 0);
  assert.equal(h.processes.length, 1);
  old.send({ kind: "command", username: "Tom", channel: "chat", message: "!bots" });
  await h.settle();
  assert.deepEqual(h.commands, [], "lines of a child that was left are ignored");
});

test("retry delays are 5, 10, 20 ... capped at 300 seconds, with one say per outage", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  for (let attempt = 0; attempt < 9; attempt += 1) {
    await h.end({ ...PLAIN_END });
    await h.wakeSleep(attempt);
  }
  assert.deepEqual(h.sleeps.map((sleep) => sleep.ms), [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  assert.equal(h.processes.length, 10);
  assert.equal(h.said.filter((line) => line.includes("socketClosed")).length, 1);
});

test("a plain disconnect after joined resets the delay to 5 s and starts a new outage line", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  await h.end({ ...PLAIN_END });
  await h.wakeSleep(0);
  await h.end({ ...PLAIN_END });
  await h.wakeSleep(1);
  await h.join();
  await h.end({ ...PLAIN_END });
  assert.deepEqual(h.sleeps.map((sleep) => sleep.ms), [5_000, 10_000, 5_000]);
  assert.equal(h.said.filter((line) => line.includes("socketClosed")).length, 2);
});

test("duplicate login kick stops retries", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  await h.join();
  await h.end({ reason: "multiplayer.disconnect.duplicate_login", duplicate: true, kicked: true });
  assert.equal(h.sleeps.length, 0);
  assert.equal(h.processes.length, 1);
  assert.equal(h.supervisor.isJoined(), false);
  assert.ok(h.said.some((line) => line.includes("Another client is on this server as MineAI: set another commands.listenerName in settings.json.")));
});

for (const reason of ["multiplayer.disconnect.not_whitelisted", "multiplayer.disconnect.banned", "multiplayer.disconnect.banned.reason: griefing", "multiplayer.disconnect.banned_ip.reason: griefing"]) {
  test(`a kick for "${reason}" stops retries and says the server's reason once`, async () => {
    const h = new Harness();
    h.supervisor.setWanted(true);
    await h.settle();
    await h.end({ reason, duplicate: false, kicked: true });
    assert.equal(h.sleeps.length, 0);
    assert.equal(h.processes.length, 1);
    assert.equal(h.said.filter((line) => line.includes(reason)).length, 1);
    assert.doesNotMatch(h.said.join("\n"), /will not retry/u, "a bot that joins and leaves makes it try again, so the line must not promise otherwise");
    assert.match(h.said.join("\n"), /whitelist or unban MineAI, or set another commands\.listenerName/u);
  });
}

for (const reason of ["multiplayer.disconnect.server_shutdown", "multiplayer.disconnect.idling", "Server restarting", "multiplayer.disconnect.flying"]) {
  test(`a kick for "${reason}" is retried like a lost connection, from the first delay`, async () => {
    const h = new Harness();
    h.supervisor.setWanted(true);
    await h.settle();
    await h.join();
    await h.end({ reason, duplicate: false, kicked: true });
    assert.deepEqual(h.sleeps.map((sleep) => sleep.ms), [5_000]);
    assert.equal(h.supervisor.isJoined(), false);
    await h.wakeSleep(0);
    assert.equal(h.processes.length, 2);
    assert.equal(h.said.filter((line) => line.includes(reason)).length, 1, "one line for the outage");
  });
}

test("kicks are retried with the delay the launcher passes, doubling up to 300 s", async () => {
  const h = new Harness({ retryFirstMs: 10_000 });
  h.supervisor.setWanted(true);
  await h.settle();
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await h.end({ reason: "multiplayer.disconnect.idling", duplicate: false, kicked: true });
    await h.wakeSleep(attempt);
  }
  assert.deepEqual(h.sleeps.map((sleep) => sleep.ms), [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
});

test("after a stopping kick, unwant then want tries again", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  await h.end({ reason: "multiplayer.disconnect.duplicate_login", duplicate: true, kicked: true });
  h.supervisor.setWanted(true);
  await h.settle();
  assert.equal(h.processes.length, 1, "still wanted: no new try");
  h.supervisor.setWanted(false);
  h.supervisor.setWanted(true);
  await h.settle();
  assert.equal(h.processes.length, 2);
});

test("isWanted is true while the listener is wanted and retrying, false when unwanted or stopped", async () => {
  const h = new Harness();
  assert.equal(h.supervisor.isWanted(), false);
  h.supervisor.setWanted(true);
  await h.settle();
  assert.equal(h.supervisor.isWanted(), true, "not joined yet");
  await h.end({ reason: "multiplayer.disconnect.idling", duplicate: false, kicked: true });
  assert.equal(h.supervisor.isWanted(), true, "a lost connection is retried");
  h.supervisor.setWanted(false);
  assert.equal(h.supervisor.isWanted(), false);
  h.supervisor.setWanted(true);
  await h.supervisor.stop();
  assert.equal(h.supervisor.isWanted(), false, "after stop() it never joins again");
});

test("isWanted is false after a duplicate login, a whitelist and a ban stop, and true again once the want is made again", async () => {
  for (const ended of [
    { reason: "multiplayer.disconnect.duplicate_login", duplicate: true, kicked: true },
    { reason: "multiplayer.disconnect.not_whitelisted", duplicate: false, kicked: true },
    { reason: "multiplayer.disconnect.banned", duplicate: false, kicked: true },
  ]) {
    const h = new Harness();
    h.supervisor.setWanted(true);
    await h.settle();
    assert.equal(h.supervisor.isWanted(), true);
    await h.end(ended);
    assert.equal(h.supervisor.isWanted(), false, `${ended.reason}: no retry will come`);
    h.supervisor.setWanted(false);
    h.supervisor.setWanted(true);
    await h.settle();
    assert.equal(h.supervisor.isWanted(), true, "the want made again tries again");
  }
});

test("a process that exits with no ended line counts as a plain disconnect", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  h.current.end();
  await h.settle();
  assert.deepEqual(h.sleeps.map((sleep) => sleep.ms), [5_000]);
});

test("whisper writes one JSON line to the process, and is false when not joined", async () => {
  const h = new Harness();
  assert.equal(h.supervisor.whisper("Tom", "hi"), false);
  h.supervisor.setWanted(true);
  await h.settle();
  assert.equal(h.supervisor.whisper("Tom", "hi"), false, "spawned but not joined");
  await h.join();
  assert.equal(h.supervisor.whisper("Tom", "hi"), true);
  assert.equal(h.current.written.length, 1);
  assert.equal(h.current.written[0]?.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(h.current.written[0] ?? ""), { kind: "whisper", to: "Tom", message: "hi" });
  await h.end({ ...PLAIN_END });
  assert.equal(h.supervisor.whisper("Tom", "hi"), false, "the process ended");
});

test("stop() during a retry wait spawns nothing", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  await h.end({ ...PLAIN_END });
  assert.equal(h.sleeps.length, 1);
  await h.supervisor.stop();
  await h.wakeSleep(0);
  assert.equal(h.processes.length, 1);
});

test("stop() stops the running process and wanting afterwards spawns nothing", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  await h.join();
  await h.supervisor.stop();
  assert.equal(h.current.stopCalls >= 1, true);
  assert.equal(h.supervisor.isJoined(), false);
  h.supervisor.setWanted(true);
  await h.settle();
  assert.equal(h.processes.length, 1);
});

test("unwant then want during a retry wait does not leave two loops", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  await h.end({ ...PLAIN_END });
  h.supervisor.setWanted(false);
  h.supervisor.setWanted(true);
  await h.settle();
  assert.equal(h.processes.length, 2, "the new want spawns at once");
  await h.wakeSleep(0);
  assert.equal(h.processes.length, 2, "the old wait wakes up and does nothing");
});

test("unwant then want while the old child is still stopping spawns the new one only after it stopped", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  await h.join();
  let release = (): void => {};
  h.current.stopGate = new Promise<void>((resolve) => (release = resolve));
  h.supervisor.setWanted(false);
  h.supervisor.setWanted(true);
  await h.settle();
  assert.equal(h.processes.length, 1, "the old child has not stopped yet");
  release();
  await h.settle();
  assert.equal(h.processes.length, 2);
});

test("a spawn that throws is said and retried, never an unhandled rejection", async () => {
  const h = new Harness({ failSpawns: 1 });
  h.supervisor.setWanted(true);
  await h.settle();
  assert.deepEqual(h.sleeps.map((sleep) => sleep.ms), [5_000]);
  assert.ok(h.said.some((line) => line.includes("spawn refused")));
  await h.wakeSleep(0);
  assert.equal(h.processes.length, 1, "the retry spawned a child");
});

test("an onCommand that throws is said, the child keeps running and the next command is handled", async () => {
  const h = new Harness({ onCommandThrowsOnce: true });
  h.supervisor.setWanted(true);
  await h.settle();
  await h.join();
  h.current.send({ kind: "command", username: "Tom", channel: "chat", message: "!bots" });
  h.current.send({ kind: "command", username: "Ann", channel: "chat", message: "!bots" });
  await h.settle();
  assert.equal(h.supervisor.isJoined(), true);
  assert.equal(h.current.stopCalls, 0);
  assert.deepEqual(h.commands.map((command) => command.username), ["Tom", "Ann"]);
  assert.ok(h.said.some((line) => line.includes("bug in onCommand")));
});

test("the outage line of a listener that never joined does not say it lost the server", async () => {
  const h = new Harness();
  h.supervisor.setWanted(true);
  await h.settle();
  await h.end({ reason: "connect ECONNREFUSED 127.0.0.1:25565", duplicate: false, kicked: false });
  assert.ok(h.said.some((line) => line.includes("could not join") && line.includes("ECONNREFUSED")));
  assert.equal(h.said.some((line) => line.includes("lost the server")), false);
});
