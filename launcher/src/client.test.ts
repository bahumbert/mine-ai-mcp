import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { bannerLines, emphasise, runConsole, startBackgroundLauncher, type ConsoleDeps } from "./client.ts";
import { startControlServer, type LauncherLock } from "./control.ts";
import type { StackStatus } from "./stack.ts";
import { RecordingHandlers, STATUS as RUNNING } from "./cli-test-support.ts";

const STATUS: StackStatus = { ...RUNNING, bots: [] };

function handlers(status: StackStatus): RecordingHandlers {
  const recording = new RecordingHandlers();
  recording.status$ = status;
  return recording;
}

interface Harness {
  out: string[];
  enterWaits: number;
  sleeps: number;
  deps: ConsoleDeps;
}

function harness(find: () => LauncherLock | null, extra: Partial<ConsoleDeps> = {}): Harness {
  const h: Harness = { out: [], enterWaits: 0, sleeps: 0, deps: undefined as unknown as ConsoleDeps };
  let time = 0;
  h.deps = {
    logsFolder: "C:\\MineAI\\logs",
    findRunningLauncher: async () => find(),
    startLauncher: () => {},
    fetch,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
      h.sleeps++;
    },
    write: (line) => void h.out.push(line),
    waitForEnter: async () => void h.enterWaits++,
    color: false,
    ...extra,
  };
  return h;
}

test("a running launcher: the client prints the banner, then the lines, and ends with the stream", async () => {
  const control = await startControlServer({ startPort: 26_300, handlers: handlers(STATUS) });
  control.publish("Ayla is running (host port 25575).");
  const h = harness(() => ({ pid: 1, controlPort: control.port, startedAt: 0 }));
  const finished = runConsole(h.deps);
  await new Promise((resolve) => setTimeout(resolve, 100));
  control.publish("Brea is running (host port 25576).");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await control.close();
  assert.equal(await finished, 0);
  const text = h.out.join("\n");
  assert.match(text, /localhost:25565/u);
  assert.match(text, /settings\.json/u);
  assert.ok(h.out.indexOf("Ayla is running (host port 25575).") > h.out.findIndex((line) => line.includes("localhost:25565")), "the banner comes first");
  assert.ok(h.out.includes("Brea is running (host port 25576)."));
  assert.match(h.out.at(-1)!, /stopped/u);
  assert.equal(h.enterWaits, 0);
});

/**
 * A launcher whose `/attach` answers with `attachAnswer` (a body, response, or error); `/status` is the real
 * endpoint's. `inits` records the `/attach` request options.
 */
async function consoleWithAttach(attachAnswer: ReadableStream<Uint8Array> | Response | Error) {
  const control = await startControlServer({ startPort: 26_340, handlers: handlers(STATUS) });
  const inits: (RequestInit | undefined)[] = [];
  const h = harness(() => ({ pid: 1, controlPort: control.port, startedAt: 0 }), {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/attach")) return await fetch(input, init);
      inits.push(init);
      if (attachAnswer instanceof Error) throw attachAnswer;
      if (attachAnswer instanceof Response) return attachAnswer;
      return new Response(attachAnswer, { status: 200 });
    }) as typeof fetch,
  });
  return { control, h, inits };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

for (const [label, data, lines, waits] of [
  ["empty", "", [], 0],
  ["data and heartbeat", ": attached\n\ndata: first\n\n: ping\n\n: ping\n\ndata: second\n\n", ["first", "second"], 0],
  ["failed start", "data: Check the server log.\n\ndata: Stopping Mine AI (mine-ai stop)...\n\nevent: outcome\ndata: failed\n\n", ["Check the server log.", "Stopping Mine AI (mine-ai stop)..."], 1],
] as const) {
test(`a ${label} stream shows its lines and waits for Enter only after failure`, async () => {
  const body = new ReadableStream<Uint8Array>({
    start: (stream) => {
      if (data) stream.enqueue(bytes(data));
      stream.close();
    },
  });
  const { control, h, inits } = await consoleWithAttach(body);
  try {
    assert.equal(await runConsole(h.deps), 0);
    assert.deepEqual(h.out.slice(-lines.length - 1), [...lines, "Mine AI has stopped."]);
    assert.ok(!h.out.includes(": ping"));
    assert.equal((inits[0] as { timeout?: unknown }).timeout, false);
    assert.equal(h.enterWaits, waits);
  } finally {
    await control.close();
  }
});
}

test("a failure after attachment waits for Enter even when another stop wins", async () => {
  const recording = handlers(STATUS);
  const control = await startControlServer({ startPort: 26_380, handlers: recording });
  let sawLine!: () => void;
  const seen = new Promise<void>((resolve) => { sawLine = resolve; });
  const h = harness(() => ({ pid: 1, controlPort: control.port, startedAt: 0 }), {
    write: (line) => { h.out.push(line); if (line === "Check the server log.") sawLine(); },
  });
  const finished = runConsole(h.deps);
  try {
    control.publish("Check the server log.");
    await seen;
    recording.status$ = { ...STATUS, phase: "stopping", problem: "Check the server log." };
    control.publish("Stopping Mine AI (mine-ai stop)...");
    await control.close();
    assert.equal(await finished, 0);
    assert.equal(h.enterWaits, 1);
  } finally {
    await control.close();
  }
});

for (const [label, response, status] of [
  ["attach 503", new Response("stopping", { status: 503 }), 503],
  ["null body", new Response(null, { status: 200 }), 200],
] as const) {
  test(`${label} does not say stopped and waits for Enter`, async () => {
    const { control, h } = await consoleWithAttach(response);
    assert.equal(await runConsole(h.deps), 0);
    await control.close();
    assert.equal(h.out.at(-1), `Could not attach to Mine AI (HTTP ${status}).`);
    assert.ok(!h.out.includes("Mine AI has stopped."));
    assert.equal(h.enterWaits, 1);
  });
}

test("a new console attaches and finishes while an earlier error waits for Enter", async () => {
  const { control, h } = await consoleWithAttach(new Response(null, { status: 503 }));
  let release!: () => void, signalPaused!: () => void, signalUnexpected!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
  const unexpected = new Promise<"blocked">((resolve) => { signalUnexpected = () => resolve("blocked"); });
  h.deps = { ...h.deps, waitForEnter: () => { h.enterWaits++; if (h.enterWaits === 1) signalPaused(); else signalUnexpected(); return gate; } };
  const first = runConsole(h.deps);
  try {
    await paused;
    const fetchFirst = h.deps.fetch;
    h.deps = { ...h.deps, fetch: (async (input: string | URL | Request, init?: RequestInit) => String(input).endsWith("/attach")
      ? new Response(new ReadableStream<Uint8Array>({ start: (stream) => { stream.enqueue(bytes("data: fresh attachment\n\n")); stream.close(); } }))
      : await fetchFirst(input, init)) as typeof fetch };
    assert.equal(await Promise.race([runConsole(h.deps), unexpected]), 0);
    assert.ok(h.out.includes("fresh attachment"));
    assert.equal(h.enterWaits, 1);
  } finally {
    release();
    assert.equal(await first, 0);
    await control.close();
  }
});

for (const [label, attachAnswer, reason] of [
  [
    "a stream that errors after a line",
    (() => {
      let pulls = 0;
      // The error comes on the second read, after the first line was delivered (`error()` would drop a queued chunk).
      return new ReadableStream<Uint8Array>({
        pull: (stream) => {
          if (pulls++ === 0) stream.enqueue(bytes("data: Ayla is running\n\n"));
          else stream.error(new Error("The operation timed out."));
        },
      });
    })(),
    "The operation timed out.",
  ],
  ["an attach that cannot connect", new TypeError("Unable to connect"), "Unable to connect"],
] as const) {
  test(`${label}: the window says it lost its connection (true while another window is open or the launcher is gone), names the error and the next step, then waits for Enter`, async () => {
    const { control, h } = await consoleWithAttach(attachAnswer);
    assert.equal(await runConsole(h.deps), 0);
    await control.close();
    assert.equal(h.out.at(-1), `This window lost its connection to Mine AI (${reason}). Mine AI stops when no window is left open. Open it again from the Start menu.`);
    assert.ok(!h.out.includes("Mine AI has stopped."));
    assert.equal(h.enterWaits, 1);
  });
}

test("no launcher yet: the client starts one, and when it never appears says so after its wait and returns 1", async () => {
  let starts = 0;
  const h = harness(() => null, { startLauncher: () => void starts++ });
  assert.equal(await runConsole(h.deps), 1);
  assert.equal(starts, 1, "a PC with no launcher gets one started");
  assert.match(h.out.join("\n"), /did not start/u);
  assert.match(h.out.join("\n"), /logs/u);
  assert.equal(h.enterWaits, 1);
});

test("a launcher that is stopping is waited for, then a new one is started", async () => {
  const stopping = await startControlServer({ startPort: 26_320, handlers: handlers({ ...STATUS, phase: "stopping" }) });
  const fresh = await startControlServer({ startPort: 26_330, handlers: handlers(STATUS) });
  let polls = 0;
  let started = false;
  const h = harness(
    () => {
      polls++;
      if (started) return { pid: 2, controlPort: fresh.port, startedAt: 0 };
      return polls < 4 ? { pid: 1, controlPort: stopping.port, startedAt: 0 } : null;
    },
    { startLauncher: () => void (started = true) },
  );
  const finished = runConsole(h.deps);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await Promise.all([stopping.close(), fresh.close()]);
  assert.equal(await finished, 0);
  assert.ok(started);
  assert.match(h.out.join("\n"), /stopping/u);
});

for (const [label, status, patterns, absent] of [
  ["a remote server says what the server must be", { ...STATUS, server: "remote", join: "play.example:25570" }, [/play\.example:25570/u, /vanilla or Paper Minecraft 1\.21\.4/u, /online-mode=false/u], []],
  ["no server in the settings file says where to set one, with the model line", { ...STATUS, server: "none", join: null }, [/Model: gemma4:12b on this PC/u, /No Minecraft server is set/u, /C:\/MineAI\/settings\.json/u], []],
  ["a launcher from before settingsFound existed (field absent) keeps the no-server line", { ...STATUS, server: "none", join: null, settingsFound: undefined as unknown as boolean }, [/No Minecraft server is set/u], []],
  [
    "no settings file has no Model line (the defaults are not the player's choice) and no settings text of its own (the stack's line is the one the player reads)",
    { ...STATUS, server: "none", join: null, settingsFound: false },
    [/Settings: C:\/MineAI\/settings\.json/u, /Close this window to stop/u],
    [/Model:/u, /No settings file/u, /No Minecraft server is set/u],
  ],
  ["a local server names the model and tells that closing the window stops everything", STATUS, [/gemma4:12b/u, /Close this window to stop/u], []],
] as const) {
  test(`the banner of ${label}`, () => {
    const text = bannerLines(status).join("\n");
    for (const pattern of patterns) assert.match(text, pattern);
    for (const pattern of absent) assert.doesNotMatch(text, pattern);
  });
}

const NO_SETTINGS_FILE_LINE = "No settings file at C:/MineAI/settings.json, so no bot starts. Run the Mine AI setup again, or mine-ai configure --server-local, then start again.";

test("no settings file: a console that replays the stack's line shows that text exactly once", async () => {
  const body = new ReadableStream<Uint8Array>({
    start: (stream) => {
      stream.enqueue(bytes(`data: ${NO_SETTINGS_FILE_LINE}\n\n`));
      stream.close();
    },
  });
  const control = await startControlServer({ startPort: 26_360, handlers: handlers({ ...STATUS, server: "none", join: null, settingsFound: false }) });
  const h = harness(() => ({ pid: 1, controlPort: control.port, startedAt: 0 }), {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => (String(input).endsWith("/attach") ? new Response(body, { status: 200 }) : await fetch(input, init))) as typeof fetch,
  });
  await runConsole(h.deps);
  await control.close();
  assert.equal(h.out.filter((line) => line.includes("so no bot starts")).length, 1);
});

const BOLD = (line: string): string => `\x1b[1m${line}\x1b[0m`;
const JOIN_LINE = "Join from Minecraft Java 1.21.4 at localhost:25565.";
const CHAT_LINE = "In the game chat: !bots lists the bots, !bot start <name> and !bot stop <name> start and stop one.";

for (const [label, status, emphasised] of [
  ["local server", STATUS, [JOIN_LINE, CHAT_LINE]],
  ["remote server", { ...STATUS, server: "remote", join: "play.example:25570", commands: { prefix: "!", audience: "disabled" } }, ["The bots join play.example:25570. That server must be vanilla or Paper Minecraft 1.21.4 with online-mode=false.", "Chat commands are off (commands.enabled is false in the settings file)."]],
] as const) {
  test(`the ${label} banner: the join line and the chat-commands line are bold with color on and no other line is; with color off nothing changes`, () => {
    const plain = bannerLines(status);
    assert.deepEqual(bannerLines(status, (line) => emphasise(line, false)), plain);
    assert.deepEqual(
      bannerLines(status, (line) => emphasise(line, true)),
      plain.map((line) => ((emphasised as readonly string[]).includes(line) ? BOLD(line) : line)),
    );
    assert.equal(plain.filter((line) => (emphasised as readonly string[]).includes(line)).length, 2, "both lines are lines of the banner");
  });
}

test("the console writes the bold lines when its deps say color", async () => {
  const control = await startControlServer({ startPort: 26_370, handlers: handlers(STATUS) });
  const h = harness(() => ({ pid: 1, controlPort: control.port, startedAt: 0 }), { color: true });
  const finished = runConsole(h.deps);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await control.close();
  await finished;
  assert.ok(h.out.includes(BOLD(JOIN_LINE)));
  assert.ok(h.out.includes(BOLD(CHAT_LINE)));
  assert.ok(h.out.includes("Mine AI"), "the other lines are plain");
});

test("a lost connection shows Bun's cause without its 'pass verbose: true' hint", async () => {
  const { control, h } = await consoleWithAttach(new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"));
  await runConsole(h.deps);
  await control.close();
  assert.equal(h.out.at(-1), "This window lost its connection to Mine AI (The socket connection was closed unexpectedly.). Mine AI stops when no window is left open. Open it again from the Start menu.");
});

for (const [label, commands, patterns, absent] of [
  ["everyone on a local server", { prefix: "!", audience: "everyone" }, [/!bots/u, /!bot start <name>/u, /!bot stop <name>/u], [/command-players/u]],
  ["listed players", { prefix: "?", audience: "listed-players" }, [/\?bots/u, /\?bot start <name>/u, /commands\.players/u], [/command-players/u]],
  ["a remote server with no players listed says how to add them", { prefix: "!", audience: "needs-players" }, [/chat commands are off/iu, /mine-ai configure --command-players/u], [/!bot start/u]],
  ["commands turned off", { prefix: "!", audience: "disabled" }, [/chat commands are off/iu, /commands\.enabled/u], [/!bot start/u, /command-players/u]],
] as const) {
  test(`the banner tells the chat commands for ${label}`, () => {
    const text = bannerLines({ ...STATUS, commands }).join("\n");
    for (const pattern of patterns) assert.match(text, pattern);
    for (const pattern of absent) assert.doesNotMatch(text, pattern);
  });
}

test("the banner of a stack with no server says nothing about chat commands", () => {
  assert.doesNotMatch(bannerLines({ ...STATUS, server: "none", join: null }).join("\n"), /chat command/iu);
});

test("the background launcher is started detached, hidden, with no console handles", () => {
  const calls: { cmd: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  let unrefs = 0;
  const spawnImpl = ((cmd: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ cmd, args, options });
    return Object.assign(new EventEmitter(), { unref: () => void unrefs++ });
  }) as never;
  startBackgroundLauncher("C:/MineAI/bun.exe", "C:/MineAI", spawnImpl);
  assert.equal(calls[0]!.cmd, "C:/MineAI/bun.exe");
  assert.ok(calls[0]!.args[0]!.replaceAll("\\", "/").endsWith("launcher/src/main.ts"));
  assert.deepEqual(calls[0]!.args.slice(1), ["start", "--expect-console"]);
  assert.equal(calls[0]!.options.detached, true);
  assert.equal(calls[0]!.options.windowsHide, true);
  assert.equal(calls[0]!.options.stdio, "ignore");
  assert.equal(unrefs, 1);
});
