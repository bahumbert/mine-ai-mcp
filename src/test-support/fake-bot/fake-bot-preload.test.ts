import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { DEFAULT_MINECRAFT_VERSION } from "../../server/config.js";

/**
 * Bun's 5 s test limit counts a test's body, not the imports before it. The default version's data (minecraft-data's
 * JSON, the registry, prismarine-chunk) took 0.45-0.53 s unloaded the first time `createFakeBot` ran: 8.3 s in the first
 * test of a file at load average 28 (quiet-machine plan Q7). So the import is done here, at the top level, and the test
 * body only reads what it loaded: a body that waited on the data would be the very test that times out under load.
 * Run alone, this file shows the old code red; in a process where another file already loaded the data it passes
 * whatever the code does (`bun run check` runs the files in one process).
 */
await import("./index.js");
const loaded = Object.keys(createRequire(import.meta.url).cache).map((file) => file.replaceAll("\\", "/"));

test(`importing the fake bot loads the ${DEFAULT_MINECRAFT_VERSION} data, so the first test of a file does not pay for it`, () => {
  assert.ok(loaded.some((file) => file.includes(`minecraft-data/data/pc/${DEFAULT_MINECRAFT_VERSION}/blocks.json`)), "the version's block data is read at import");
  assert.ok(loaded.some((file) => file.includes("prismarine-chunk/src/pc/")), "the chunk class of the version is loaded at import");
});
