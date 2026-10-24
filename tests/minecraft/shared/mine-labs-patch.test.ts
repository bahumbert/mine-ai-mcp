import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as mineLabs from "mine-labs";

/** What the scenario server (tests/minecraft/shared) runs a trial with: the pinned package exports it only through patches/. */
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

/** A server that is never started: only its generated `server.properties` is read. */
async function serverProperties(extra: { enableCommandBlocks?: boolean; maxHeap?: string; pauseWhenEmptySeconds?: number }): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-patch-"));
  try {
    const server = new mineLabs.MinecraftServer(
      {
        version: "1.21.4", host: "127.0.0.1", worldDir: join(root, "world"), gamePort: 0, rconPort: 0,
        rconPassword: "test", worldType: "flat", structures: false, operators: [], ...extra,
      },
      "unused.jar",
      () => {},
      { gamePort: 0, rconPort: 0, release() {} },
    );
    await (server as unknown as { writeConfig(): Promise<void> }).writeConfig();
    return (await readFile(join(root, "server.properties"), "utf8")).split("\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a server created without the new options writes no command block line and keeps the 2G heap", async () => {
  const properties = await serverProperties({});
  assert.equal(properties.some((line) => line.startsWith("enable-command-block")), false);
  assert.ok(properties.includes("max-players=10"));
  assert.equal(properties.some((line) => line.startsWith("pause-when-empty-seconds")), false, "without the option the game's own default stands");
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
test("without arena options compileScenario returns what the unpatched package returned for the scenarios not edited since", async () => {
  const snapshot = JSON.parse(await readFile(join(import.meta.dirname, "mine-labs-compile.snapshot.json"), "utf8")) as Record<string, { sha256: string; compiled: unknown }>;
  const files = Object.keys(snapshot);
  assert.ok(files.length >= 94, `snapshot holds ${files.length} scenarios`);
  let compared = 0;
  for (const file of files) {
    const path = join(import.meta.dirname, "../../..", file);
    if (createHash("sha256").update(await readFile(path)).digest("hex") !== snapshot[file]!.sha256) continue;
    const scenario = await mineLabs.loadScenario(path);
    assert.deepEqual(JSON.parse(JSON.stringify(mineLabs.compileScenario(scenario))), snapshot[file]!.compiled, file);
    compared += 1;
  }
  assert.ok(compared >= files.length / 2, `only ${compared} of ${files.length} scenarios are unchanged since the snapshot: regenerate it`);
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
