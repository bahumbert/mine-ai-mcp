import assert from "node:assert/strict";
import test from "node:test";
import { settingsPath } from "./settings.ts";
import { stackFixture } from "./stack-test-support.ts";
import { startBot, startStack } from "./stack.ts";

for (const [label, settingsFileExists, expected] of [
  [
    "no settings file: the text says there is no file, the path and the way to get one",
    false,
    (root: string) => `There is no settings file at ${settingsPath(root)}, so there is no Minecraft server to join. Run the Mine AI setup again, or mine-ai configure --server-local, then start Mine AI again.`,
  ],
  [
    "a settings file with no server: the text says where to set one",
    true,
    (root: string) => `There is no Minecraft server to join. Set one in ${settingsPath(root)} ("server"), then start Mine AI again.`,
  ],
] as const) {
  test(`startBot on a running stack with no server, ${label}`, async () => {
    const fixture = stackFixture((settings) => ({ ...settings, server: { kind: "none" } }));
    const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, { ...fixture.deps, settingsFileExists: () => settingsFileExists });
    assert.equal(state.phase, "running");
    const outcome = await startBot(state, "ayla");
    assert.deepEqual(outcome, { ok: false, reason: "not-ready", message: expected(fixture.root) });
    assert.deepEqual(fixture.children.spawns, []);
  });
}
