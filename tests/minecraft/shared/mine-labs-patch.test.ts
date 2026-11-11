import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { describe } from "node:test";
import * as mineLabs from "mine-labs";

/** What the scenario server (tests/minecraft/shared) runs a trial with: the pinned package exports it only through patches/. */
// check-reads: tests/minecraft/shared/mine-labs-compile.snapshot.json, tests/minecraft/scenarios/**/*.yaml, tests/minecraft/contract/scenarios/**/*.yaml, tests/minecraft/templates/**/*.yaml
const SCENARIO_SERVER_EXPORTS = [
  "runScenarioTrial",
  "MinecraftServer",
  "prepareWorldDir",
  "writeRunResult",
  "canResetScenario",
  "worldCompatibilityKey",
  "compileScenario",
  "launchScenarioClient",
  "spawnClientAhead",
] as const;

test("the patched mine-labs exports what the scenario server runs a trial with", () => {
  for (const name of SCENARIO_SERVER_EXPORTS) {
    assert.equal(typeof (mineLabs as Record<string, unknown>)[name], "function", `mine-labs does not export ${name}`);
  }
});

type ServerOptions = { enableCommandBlocks?: boolean; maxHeap?: string; pauseWhenEmptySeconds?: number; properties?: Readonly<Record<string, string>> };

/** A server that never runs: `body` gets it and its folder, and `server.properties` is read through `read`. */
async function withUnstartedServer<T>(
  extra: ServerOptions,
  body: (server: InstanceType<typeof mineLabs.MinecraftServer>, read: () => Promise<string[]>, file: string) => Promise<T>,
  log: (message: string) => void = () => {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-patch-"));
  try {
    const server = new mineLabs.MinecraftServer(
      {
        version: "1.21.4", host: "127.0.0.1", worldDir: join(root, "world"), gamePort: 0, rconPort: 0,
        rconPassword: "test", worldType: "flat", structures: false, operators: [], ...extra,
      },
      "unused.jar",
      log,
      { gamePort: 0, rconPort: 0, release() {} },
    );
    const file = join(root, "server.properties");
    return await body(server, async () => (await readFile(file, "utf8")).split("\n"), file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A server that is never started: only its generated `server.properties` is read. */
async function serverProperties(extra: ServerOptions): Promise<string[]> {
  return withUnstartedServer(extra, async (server, read) => {
    await (server as unknown as { writeConfig(): Promise<void> }).writeConfig();
    return read();
  });
}

test("a server created without the new options keeps the 2G heap", () => {
  assert.deepEqual(mineLabs.serverJavaArgs({ maxHeap: undefined }, "server.jar"), ["-Xms512M", "-Xmx2G", "-jar", "server.jar", "nogui"]);
});

test("a server asked for command blocks and a heap writes the line and passes -Xmx", async () => {
  const properties = await serverProperties({ enableCommandBlocks: true, maxHeap: "4G" });
  assert.ok(properties.includes("enable-command-block=true"));
  assert.deepEqual(mineLabs.serverJavaArgs({ maxHeap: "4G" }, "server.jar"), ["-Xms512M", "-Xmx4G", "-jar", "server.jar", "nogui"]);
});

test("a server asked never to pause when empty writes pause-when-empty-seconds=0", async () => {
  const properties = await serverProperties({ pauseWhenEmptySeconds: 0 });
  assert.ok(properties.includes("pause-when-empty-seconds=0"));
  assert.ok((await serverProperties({ pauseWhenEmptySeconds: 30 })).includes("pause-when-empty-seconds=30"));
});

// The text the unpatched package writes for this config (typed from its writeConfig, mine-labs@aba1cdf, 2026-10-31).
const UNPATCHED_SERVER_PROPERTIES = [
  "server-ip=127.0.0.1",
  "server-port=0",
  "online-mode=false",
  "spawn-protection=0",
  "enable-rcon=true",
  "rcon.port=0",
  "rcon.password=test",
  "level-name=world",
  "level-type=minecraft\\:flat",
  'generator-settings={"biome"\\:"minecraft\\:plains","lakes"\\:false,"features"\\:false,"layers"\\:[{"block"\\:"minecraft\\:bedrock","height"\\:1},{"block"\\:"minecraft\\:dirt","height"\\:2},{"block"\\:"minecraft\\:grass_block","height"\\:1}],"structure_overrides"\\:[]}',
  "generate-structures=false",
  "spawn-monsters=true",
  "spawn-animals=false",
  "view-distance=8",
  "simulation-distance=8",
  "max-players=10",
].join("\n");

/** The unpatched text with `replaced` lines (by key) swapped in place and `appended` lines after the last one. */
function unpatchedWith(replaced: Record<string, string>, appended: string[]): string[] {
  const lines = UNPATCHED_SERVER_PROPERTIES.split("\n").map((line) => {
    const key = line.slice(0, line.indexOf("="));
    return key in replaced ? `${key}=${replaced[key]}` : line;
  });
  return [...lines, ...appended];
}

test("properties replace a held key in place once and append the others in order", async () => {
  const cases: { name: string; options: ServerOptions; expected: string[] }[] = [
    {
      name: "a fixed key replaced, a new key appended",
      options: { properties: { "view-distance": "4", "sync-chunk-writes": "false" } },
      expected: unpatchedWith({ "view-distance": "4" }, ["sync-chunk-writes=false"]),
    },
    {
      name: "new keys keep the order they were given",
      options: { properties: { "sync-chunk-writes": "false", "max-tick-time": "-1" } },
      expected: unpatchedWith({}, ["sync-chunk-writes=false", "max-tick-time=-1"]),
    },
    {
      name: "a line the server's own options wrote is replaced, not repeated",
      options: { enableCommandBlocks: true, pauseWhenEmptySeconds: 30, properties: { "enable-command-block": "false", "pause-when-empty-seconds": "0" } },
      expected: unpatchedWith({}, ["pause-when-empty-seconds=0", "enable-command-block=false"]),
    },
    {
      name: "a value keeps its = and colons, an even run of backslashes may end it, a key matches whole and not by prefix",
      options: { properties: { "level-name": "a=b\\:c\\\\", view: "1" } },
      expected: unpatchedWith({ "level-name": "a=b\\:c\\\\" }, ["view=1"]),
    },
  ];
  for (const { name, options, expected } of cases) {
    assert.deepEqual(await serverProperties(options), expected, name);
  }
});

test("a property key the game would cut or a value that would write or swallow a line is refused with its name", async () => {
  const refused: { properties: Record<string, string>; message: string }[] = [
    { properties: { "": "1" }, message: 'server property key ""' },
    { properties: { "a=b": "1" }, message: 'server property key "a=b"' },
    { properties: { "a b": "1" }, message: 'server property key "a b"' },
    { properties: { "a:b": "1" }, message: 'server property key "a:b"' },
    { properties: { "#a": "1" }, message: 'server property key "#a"' },
    { properties: { "a\nb": "1" }, message: 'server property key "a\\nb"' },
    { properties: { a: "1\nenable-rcon=false" }, message: 'server property value of "a"' },
    { properties: { a: "1\r" }, message: 'server property value of "a"' },
    { properties: { "level-name": "x\\" }, message: 'server property value of "level-name"' },
    { properties: { "level-name": "x\\\\\\" }, message: 'server property value of "level-name"' },
  ];
  for (const { properties, message } of refused) {
    await assert.rejects(serverProperties({ properties }), (error: Error) => error.message.startsWith(message), JSON.stringify(properties));
  }
});

test("create refuses a bad property before it reserves ports or fetches a jar", async () => {
  const root = join(tmpdir(), "mine-labs-patch-create-never-used");
  await assert.rejects(
    mineLabs.MinecraftServer.create({ version: "1.21.4", root, log: () => {}, properties: { "a b": "1" } }),
    (error: Error) => error.message.startsWith('server property key "a b"'),
  );
});

test("no properties: the same server.properties as unpatched", async () => {
  assert.equal((await serverProperties({})).join("\n"), UNPATCHED_SERVER_PROPERTIES);
  assert.equal((await serverProperties({ properties: undefined })).join("\n"), UNPATCHED_SERVER_PROPERTIES);
  assert.equal((await serverProperties({ properties: {} })).join("\n"), UNPATCHED_SERVER_PROPERTIES);
});

test("a second start() writes the properties again", async () => {
  // start() checks its signal only before the first await: aborting right after the call lets it write the config and spawn,
  // then waitReady throws the AbortError. JAVA_HOME names a folder with no java, so the spawn finds no process to run.
  const previous = process.env.JAVA_HOME;
  process.env.JAVA_HOME = join(tmpdir(), "mine-labs-patch-no-java");
  const startAborted = async (server: { start(signal: AbortSignal): Promise<void> }): Promise<void> => {
    const controller = new AbortController();
    const started = server.start(controller.signal);
    controller.abort();
    await assert.rejects(started, { name: "AbortError" });
  };
  try {
    await withUnstartedServer({ properties: { "sync-chunk-writes": "false" } }, async (server, read, file) => {
      await startAborted(server);
      assert.equal((await read()).at(-1), "sync-chunk-writes=false");
      await rm(file);
      await startAborted(server);
      assert.equal((await read()).at(-1), "sync-chunk-writes=false", "the restart path writes the file again");
    });
  } finally {
    if (previous === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = previous;
  }
});

test("the server JVM receives the executable lshw stub first on its PATH", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-java-"));
  const previous = process.env.JAVA_HOME;
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "java"), `#!/bin/sh\nprintf '%s' "$PATH" > '${root}/path'\nexit 1\n`, { mode: 0o755 });
    process.env.JAVA_HOME = root;
    await withUnstartedServer({}, async server => {
      await assert.rejects(server.start());
    });
    const path = await readFile(join(root, "path"), "utf8");
    const stubDir = join(tmpdir(), "mine-ai-stubs");
    assert.equal(path.split(delimiter)[0], stubDir);
    assert.equal(spawnSync("lshw", [], { env: { PATH: path } }).status, 1);
  } finally {
    if (previous === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("the JVM gets one stub directory for an empty or already-prefixed PATH", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-path-"));
  const previousHome = process.env.JAVA_HOME;
  const previousPath = process.env.PATH;
  const stubDir = join(tmpdir(), "mine-ai-stubs");
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "java"), `#!/bin/sh\nprintf '%s' "$PATH" > '${root}/path'\nexit 1\n`, { mode: 0o755 });
    process.env.JAVA_HOME = root;
    for (const path of ["", `${stubDir}${delimiter}/usr/bin`]) {
      process.env.PATH = path;
      await withUnstartedServer({}, async server => { await assert.rejects(server.start()); });
      const entries = (await readFile(join(root, "path"), "utf8")).split(delimiter);
      assert.equal(entries[0], stubDir);
      assert.equal(entries.filter(entry => entry === stubDir).length, 1);
      assert.ok(entries.every(Boolean));
    }
  } finally {
    if (previousHome === undefined) delete process.env.JAVA_HOME; else process.env.JAVA_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("a Windows JVM keeps its environment without installing the POSIX stub", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-win32-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previousHome = process.env.JAVA_HOME;
  const previousTemp = process.env.TMPDIR;
  const previousPath = process.env.PATH;
  const previousMixedPath = process.env.Path;
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "javaw.exe"), `#!/bin/sh\n/usr/bin/env > '${root}/env'\nexit 1\n`, { mode: 0o755 });
    process.env.JAVA_HOME = root;
    process.env.TMPDIR = root;
    process.env.PATH = "/usr/bin:/bin";
    process.env.Path = "windows-path";
    await withUnstartedServer({}, async server => {
      Object.defineProperty(process, "platform", { value: "win32" });
      await assert.rejects(server.start());
    });
    const env = (await readFile(join(root, "env"), "utf8")).split("\n");
    assert.ok(env.includes("PATH=/usr/bin:/bin"));
    assert.ok(env.includes("Path=windows-path"));
    await assert.rejects(readFile(join(root, "mine-ai-stubs", "lshw")), { code: "ENOENT" });
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previousHome === undefined) delete process.env.JAVA_HOME; else process.env.JAVA_HOME = previousHome;
    if (previousTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemp;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousMixedPath === undefined) delete process.env.Path; else process.env.Path = previousMixedPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("a stub installation failure is logged and the JVM retains its original PATH", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-java-failure-"));
  const previousHome = process.env.JAVA_HOME;
  const previousTemp = process.env.TMPDIR;
  const previousPath = process.env.PATH;
  const logs: string[] = [];
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "java"), `#!/bin/sh\nprintf '%s' "$PATH" > '${root}/path'\nexit 1\n`, { mode: 0o755 });
    await writeFile(join(root, "not-a-directory"), "");
    process.env.JAVA_HOME = root;
    process.env.PATH = "/usr/bin:/bin";
    await withUnstartedServer({}, async server => {
      process.env.TMPDIR = join(root, "not-a-directory");
      await assert.rejects(server.start());
    }, message => logs.push(message));
    assert.equal(await readFile(join(root, "path"), "utf8"), "/usr/bin:/bin");
    assert.ok(logs.some(message => message.includes("lshw stub not installed")));
  } finally {
    if (previousHome === undefined) delete process.env.JAVA_HOME; else process.env.JAVA_HOME = previousHome;
    if (previousTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemp;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

const LANE_BOX ={ minX: -512, minY: -64, minZ: 1024 - 256, maxX: 1535, maxY: 319, maxZ: 1024 + 255 };

/** A resettable scenario with a tick command and an entity, as a lane runs one. */
function laneScenario() {
  return mineLabs.scenarioSchema.parse({
    name: "lane",
    client: { command: "test-client" },
    reset: ["fill -8 -59 -8 8 -40 8 air"],
    geometry: [{ setblock: { block: "stone", at: [0, -59, 0] } }],
    entities: [{ type: "zombie", pos: [1, -59, 1] }],
    tick: ["say one", String.raw`say "two" \ end`],
    goal: { kind: "survive", seconds: 1 },
  });
}

const BLOCK_LIMIT = "gamerule commandModificationBlockLimit";

// The snapshot is the unpatched package's output for each YAML as it stood on 2026-10-23, with the sha256 of the YAML
// text: a scenario edited since is skipped (its compiled output may change legitimately), the rest must still match.
// Regenerate with .agent/scripts/scenario-capacity-probe/compile-snapshot.ts on a pristine mine-labs.
// One test per snapshot entry: a single test looping over all of them grew past the 5 s test timeout as scenarios were added.
const COMPILE_SNAPSHOT = JSON.parse(readFileSync(join(import.meta.dirname, "mine-labs-compile.snapshot.json"), "utf8")) as Record<string, { sha256: string; compiled: unknown }>;
const SNAPSHOT_FILES = Object.keys(COMPILE_SNAPSHOT);
const UNEDITED_SNAPSHOT_FILES = new Set(
  SNAPSHOT_FILES.filter((file) => createHash("sha256").update(readFileSync(join(import.meta.dirname, "../../..", file))).digest("hex") === COMPILE_SNAPSHOT[file]!.sha256),
);

describe("without arena options compileScenario returns what the unpatched package returned for the scenarios not edited since", () => {
  test("the snapshot holds at least 94 scenarios, half of them unedited since", () => {
    assert.ok(SNAPSHOT_FILES.length >= 94, `snapshot holds ${SNAPSHOT_FILES.length} scenarios`);
    assert.ok(UNEDITED_SNAPSHOT_FILES.size >= SNAPSHOT_FILES.length / 2, `only ${UNEDITED_SNAPSHOT_FILES.size} of ${SNAPSHOT_FILES.length} scenarios are unchanged since the snapshot: regenerate it`);
  });

  for (const file of SNAPSHOT_FILES) {
    // An edited scenario (its YAML hash changed) is skipped: its compiled output may change legitimately.
    const register = UNEDITED_SNAPSHOT_FILES.has(file) ? test : test.skip;
    register(file, async () => {
      const scenario = await mineLabs.loadScenario(join(import.meta.dirname, "../../..", file));
      assert.deepEqual(JSON.parse(JSON.stringify(mineLabs.compileScenario(scenario))), COMPILE_SNAPSHOT[file]!.compiled, file);
    });
  }
});

test("the boxed entity clear names the lane's box and leaves players alone", () => {
  assert.equal(
    mineLabs.boxedClearEntities(LANE_BOX),
    "kill @e[type=!minecraft:player,x=-512,y=-64,z=768,dx=2047,dy=383,dz=511]",
  );
});

test("a lane's compiled scenario kills inside its box and never sets the server-wide block limit", () => {
  const compiled = mineLabs.compileScenario(laneScenario(), { entityBox: LANE_BOX, tickBlocks: true });
  const commands = [...compiled.setup, ...compiled.teardown, ...(compiled.snapshot?.save ?? []), ...(compiled.snapshot?.restore ?? [])];
  assert.equal(commands.some((command) => command.startsWith(BLOCK_LIMIT)), false);
  assert.equal(compiled.teardown[0], mineLabs.boxedClearEntities(LANE_BOX));
  assert.equal(compiled.teardown.includes(mineLabs.CLEAR_ENTITIES), false);
  // A kill drops each mob's loot after it chose its targets; the drops are saved with the unpinned chunks and load back under the next player.
  assert.equal(compiled.teardown[1], mineLabs.boxedClearEntities(LANE_BOX), "a second clear takes the loot the first one dropped");
  assert.ok(compiled.setup.includes("gamerule commandBlockOutput false"));
  assert.ok(compiled.snapshot?.save.some((command) => command.startsWith("clone ")));
});

test("the command block output gamerule is set only when tick blocks are asked for", () => {
  const withoutBlocks = mineLabs.compileScenario(laneScenario(), { entityBox: LANE_BOX });
  assert.equal(withoutBlocks.setup.includes("gamerule commandBlockOutput false"), false);
});

test("scoped unpin removes each region's own chunks, per dimension", () => {
  const overworld = { dimension: "overworld", minX: -24, minY: -64, minZ: 1000, maxX: 28, maxY: 100, maxZ: 1040, chunks: 12 } as const;
  const scratch = { ...overworld, minX: 540, maxX: 592 };
  const nether = { ...overworld, dimension: "the_nether", minX: 0, maxX: 15, minZ: 0, maxZ: 15, chunks: 1 } as const;
  assert.deepEqual(mineLabs.unpinCommands([overworld, scratch, nether], { scoped: true }), [
    "forceload remove -24 1000 28 1040",
    "forceload remove 540 1000 592 1040",
    "execute in minecraft:the_nether run forceload remove 0 0 15 15",
  ]);
  assert.deepEqual(mineLabs.unpinCommands([overworld, scratch, nether]), [
    "forceload remove all",
    "execute in minecraft:the_nether run forceload remove all",
  ]);
});

const CONTROL = { x: -496, z: 784 };

test("tick commands become a repeating command block and chain command blocks, installed tail first and removed head first", () => {
  const blocks = mineLabs.tickBlockCommands(["say one", String.raw`say "two" \ end`, "say three"], CONTROL, "overworld");
  assert.deepEqual(blocks?.install, [
    String.raw`setblock -494 -63 784 minecraft:chain_command_block[facing=east]{Command:"say three",auto:1b,TrackOutput:0b}`,
    String.raw`setblock -495 -63 784 minecraft:chain_command_block[facing=east]{Command:"say \"two\" \\ end",auto:1b,TrackOutput:0b}`,
    String.raw`setblock -496 -63 784 minecraft:repeating_command_block[facing=east]{Command:"say one",auto:1b,TrackOutput:0b}`,
  ]);
  assert.deepEqual(blocks?.remove, [
    "setblock -496 -63 784 minecraft:air",
    "setblock -495 -63 784 minecraft:air",
    "setblock -494 -63 784 minecraft:air",
  ]);
  assert.deepEqual(blocks?.region, {
    dimension: "overworld", minX: -496, maxX: -494, minY: -63, maxY: -63, minZ: 784, maxZ: 784, chunks: 1,
  });
});

test("a scenario without tick commands installs no command blocks", () => {
  assert.equal(mineLabs.tickBlockCommands([], CONTROL, "overworld"), null);
});

test("tick command blocks of a scenario in another dimension run their command there, like the datapack did", () => {
  const blocks = mineLabs.tickBlockCommands(["say nether"], CONTROL, "the_nether");
  assert.equal(
    blocks?.install[0],
    String.raw`execute in minecraft:the_nether run setblock -496 -63 784 minecraft:repeating_command_block[facing=east]{Command:"execute in minecraft:the_nether run say nether",auto:1b,TrackOutput:0b}`,
  );
});


// Measured on a real 1.21.4 server (scenario-capacity-probe/rcon-limit.ts): a 1446-byte command is answered, a 1447-byte one never.
// The installing setblock goes out through executeChecked, which wraps it in CHECKED_COMMAND_PREFIX.
const sentBytes = (install: string): number => Buffer.byteLength(mineLabs.CHECKED_COMMAND_PREFIX + install);
const baseSent = sentBytes(mineLabs.tickBlockCommands(["say "], CONTROL, "overworld")!.install[0]!);

test("a tick command whose installing setblock RCON cannot carry is refused with its size and a way out", () => {
  assert.equal(mineLabs.MAX_RCON_COMMAND_BYTES, 1446);
  const room = mineLabs.MAX_RCON_COMMAND_BYTES - baseSent;
  const cases: { name: string; commands: string[]; refused: RegExp | null }[] = [
    { name: "exactly at the limit", commands: [`say ${"x".repeat(room)}`], refused: null },
    { name: "one byte over", commands: [`say ${"x".repeat(room + 1)}`], refused: /tick command 1 needs a 1447-byte setblock.*1446.*shorten it/u },
    { name: "two-byte characters count as bytes", commands: [`say ${"é".repeat(room / 2 + 1)}`], refused: /byte setblock/u },
    { name: "in the middle of the row (a chain block name is 4 bytes shorter)", commands: ["say one", `say ${"x".repeat(room + 5)}`], refused: /tick command 2 /u },
  ];
  for (const { name, commands, refused } of cases) {
    if (!refused) {
      const blocks = mineLabs.tickBlockCommands(commands, CONTROL, "overworld")!;
      assert.equal(sentBytes(blocks.install[0]!), mineLabs.MAX_RCON_COMMAND_BYTES, name);
    } else {
      assert.throws(() => mineLabs.tickBlockCommands(commands, CONTROL, "overworld"), refused, name);
    }
  }
});
