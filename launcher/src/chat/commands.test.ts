import assert from "node:assert/strict";
import test from "node:test";
import type { PersonaEntry } from "../personas.ts";
import { runChatCommand, type BotControl } from "./commands.ts";

type BotStatus = "starting" | "running" | "stopping" | "ended";

const PERSONAS: PersonaEntry[] = [
  { id: "ayla", username: "Ayla", path: "/p/ayla.json" },
  { id: "brea", username: "Brea", path: "/p/brea.json" },
  { id: "cleo-2", username: "Cleo", path: "/p/cleo-2.json" },
];

class FakeControl implements BotControl {
  readonly calls: string[] = [];
  startResult: { ok: boolean; message: string } | Error = { ok: true, message: "Brea is playing." };
  stopResult: { ok: boolean; message: string } | Error = { ok: true, message: "Brea has left." };
  constructor(
    private readonly playing: Record<string, BotStatus> = {},
    private readonly known: readonly PersonaEntry[] = PERSONAS,
  ) {}
  personas(): readonly PersonaEntry[] {
    return this.known;
  }
  bots(): readonly { id: string; username: string; status: BotStatus }[] {
    return Object.entries(this.playing).map(([id, status]) => ({ id, username: this.known.find((entry) => entry.id === id)?.username ?? id, status }));
  }
  async start(id: string): Promise<{ ok: boolean; message: string }> {
    this.calls.push(`start ${id}`);
    if (this.startResult instanceof Error) throw this.startResult;
    return this.startResult;
  }
  async stop(id: string): Promise<{ ok: boolean; message: string }> {
    this.calls.push(`stop ${id}`);
    if (this.stopResult instanceof Error) throw this.stopResult;
    return this.stopResult;
  }
}

async function run(command: Parameters<typeof runChatCommand>[0], control: BotControl, prefix = "!"): Promise<{ answers: string[]; summary: string }> {
  const answers: string[] = [];
  const summary = await runChatCommand(command, control, async (text) => void answers.push(text), prefix);
  return { answers, summary };
}

test("list: personas not playing, then the ones playing, by username", async () => {
  const { answers, summary } = await run({ kind: "list" }, new FakeControl({ "cleo-2": "running", ayla: "starting" }));
  assert.deepEqual(answers, ["Not started: Brea | Playing: Ayla, Cleo"]);
  assert.equal(summary, "!bots -> Not started: Brea | Playing: Ayla, Cleo");
});

test("list: a bot that ended counts as not started; stopping counts as playing", async () => {
  const { answers } = await run({ kind: "list" }, new FakeControl({ ayla: "ended", brea: "stopping", "cleo-2": "running" }));
  assert.deepEqual(answers, ["Not started: Ayla | Playing: Brea, Cleo"]);
});

test("list: everybody playing, and nobody playing", async () => {
  const all = await run({ kind: "list" }, new FakeControl({ ayla: "running", brea: "running", "cleo-2": "running" }));
  assert.deepEqual(all.answers, ["All bots are playing."]);
  const none = await run({ kind: "list" }, new FakeControl({}));
  assert.deepEqual(none.answers, ["Not started: Ayla, Brea, Cleo | No bot is playing."]);
  const empty = await run({ kind: "list" }, new FakeControl({}, []));
  assert.deepEqual(empty.answers, ["No bot is set up: add a persona file (<name>.json with a username) to the personas folder."]);
});

test("list: the persona list comes only from personas()", async () => {
  const only: PersonaEntry[] = [{ id: "zed", username: "Zed", path: "/p/zed.json" }];
  const { answers } = await run({ kind: "list" }, new FakeControl({}, only));
  assert.deepEqual(answers, ["Not started: Zed | No bot is playing."]);
});

test("start: an unknown name is answered with the list hint and starts nothing", async () => {
  const control = new FakeControl();
  const { answers, summary } = await run({ kind: "start", name: "../ayla" }, control, "!");
  assert.deepEqual(answers, ["No bot named ../ayla. Type !bots for the list."]);
  assert.deepEqual(control.calls, []);
  assert.equal(summary, "!bot start ../ayla -> No bot named ../ayla. Type !bots for the list.");
});

test("start: a name with control characters is answered with them replaced", async () => {
  const { answers } = await run({ kind: "start", name: "ay\u0000la\u001b[31m§" }, new FakeControl());
  assert.deepEqual(answers, ["No bot named ay?la?[31m?. Type !bots for the list."]);
});

test("start: answers Starting <Username>... first, then the control's message", async () => {
  const control = new FakeControl();
  const { answers, summary } = await run({ kind: "start", name: "BREA" }, control);
  assert.deepEqual(answers, ["Starting Brea...", "Brea is playing."]);
  assert.deepEqual(control.calls, ["start brea"]);
  assert.equal(summary, "!bot start BREA -> Brea is playing.");
});

test("start: by id when the id differs from the username", async () => {
  const control = new FakeControl();
  await run({ kind: "start", name: "cleo-2" }, control);
  assert.deepEqual(control.calls, ["start cleo-2"]);
});

test("start: a bot already starting or running gets the control's message only", async () => {
  for (const status of ["starting", "running", "stopping"] as const) {
    const control = new FakeControl({ brea: status });
    control.startResult = { ok: false, message: `Brea is ${status}.` };
    const { answers } = await run({ kind: "start", name: "brea" }, control);
    assert.deepEqual(answers, [`Brea is ${status}.`], status);
    assert.deepEqual(control.calls, ["start brea"]);
  }
});

test("start: an ended bot is started again", async () => {
  const control = new FakeControl({ brea: "ended" });
  const { answers } = await run({ kind: "start", name: "brea" }, control);
  assert.deepEqual(answers, ["Starting Brea...", "Brea is playing."]);
});

test("start: a start that fails is answered with the control's message as is", async () => {
  const control = new FakeControl();
  control.startResult = { ok: false, message: "Brea's host did not answer within 90 s. See the launcher log." };
  const { answers } = await run({ kind: "start", name: "brea" }, control);
  assert.deepEqual(answers, ["Starting Brea...", "Brea's host did not answer within 90 s. See the launcher log."]);
});

test("start: a control that throws is answered, not rethrown", async () => {
  const control = new FakeControl();
  control.startResult = new Error("spawn failed");
  const { answers } = await run({ kind: "start", name: "brea" }, control);
  assert.deepEqual(answers, ["Starting Brea...", "Could not start Brea: spawn failed"]);
});

test("stop: a running bot gets Stopping <Username>... then the control's message", async () => {
  const control = new FakeControl({ brea: "running" });
  const { answers, summary } = await run({ kind: "stop", name: "Brea" }, control);
  assert.deepEqual(answers, ["Stopping Brea...", "Brea has left."]);
  assert.deepEqual(control.calls, ["stop brea"]);
  assert.equal(summary, "!bot stop Brea -> Brea has left.");
});

test("stop: a starting bot is stopped too", async () => {
  const control = new FakeControl({ brea: "starting" });
  const { answers } = await run({ kind: "stop", name: "brea" }, control);
  assert.deepEqual(answers, ["Stopping Brea...", "Brea has left."]);
});

test("stop: an unknown name is answered and stops nothing", async () => {
  const control = new FakeControl({ brea: "running" });
  const { answers } = await run({ kind: "stop", name: "nobody" }, control);
  assert.deepEqual(answers, ["No bot named nobody. Type !bots for the list."]);
  assert.deepEqual(control.calls, []);
});

test("stop: a bot that is not running gets the control's own message, with no Stopping line", async () => {
  for (const playing of [{}, { brea: "ended" }, { brea: "stopping" }] as Record<string, BotStatus>[]) {
    const control = new FakeControl(playing);
    control.stopResult = { ok: false, message: "Brea is not running." };
    const { answers } = await run({ kind: "stop", name: "brea" }, control);
    assert.deepEqual(answers, ["Brea is not running."]);
  }
});

test("stop: a control that throws is answered", async () => {
  const control = new FakeControl({ brea: "running" });
  control.stopResult = new Error("host gone");
  const { answers } = await run({ kind: "stop", name: "brea" }, control);
  assert.deepEqual(answers, ["Stopping Brea...", "Could not stop Brea: host gone"]);
});

test("help: one usage line with the prefix", async () => {
  const { answers, summary } = await run({ kind: "help" }, new FakeControl(), "@@");
  assert.deepEqual(answers, ["Commands: @@bots, @@bot start <name>, @@bot stop <name>"]);
  assert.equal(summary, "@@bot help -> Commands: @@bots, @@bot start <name>, @@bot stop <name>");
});

test("an answer that fails does not stop the command, and the summary says so", async () => {
  const control = new FakeControl();
  const summary = await runChatCommand({ kind: "start", name: "brea" }, control, async () => {
    throw new Error("whisper refused");
  }, "!");
  assert.deepEqual(control.calls, ["start brea"], "the start still ran");
  assert.match(summary, /^!bot start brea -> Brea is playing\. \(answer failed: whisper refused\)$/u);
});
