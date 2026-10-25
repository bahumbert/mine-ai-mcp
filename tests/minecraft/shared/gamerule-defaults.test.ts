import test from "node:test";
import assert from "node:assert/strict";
import { fixtureScenario } from "./scenario-fixture.ts";
import { GameruleDefaultsCache } from "./gamerule-defaults.ts";
import type { ScenarioServer } from "./scenario-server.ts";

const example = fixtureScenario(10);

function probeAnswering(values: Record<string, string>, asked: string[]): ScenarioServer {
  return {
    id: "probe", kind: "shared", gamePort: 25_400, heapMb: 3_072, javaPid: () => null, stop: async () => {},
    command: async command => {
      const rule = command.replace("gamerule ", "");
      asked.push(rule);
      return rule in values ? `Gamerule ${rule} is currently set to: ${values[rule]}` : `Unknown or incomplete command`;
    },
  };
}

test("only the rules not yet known are asked of the probe, once each", async () => {
  const asked: string[] = [];
  let probes = 0;
  const cache = new GameruleDefaultsCache(async () => { probes += 1; return probeAnswering({ doFireTick: "true", randomTickSpeed: "3" }, asked); });
  await cache.ensure("1.21.4", ["doFireTick", "randomTickSpeed"], example);
  await cache.ensure("1.21.4", ["doFireTick", "randomTickSpeed"], example);
  assert.deepEqual(asked, ["doFireTick", "randomTickSpeed"]);
  assert.equal(probes, 1);
  assert.deepEqual(cache.forVersion("1.21.4"), { doFireTick: "true", randomTickSpeed: "3" });
});

test("no probe server is started when every wanted rule is known or none is wanted", async () => {
  let probes = 0;
  const cache = new GameruleDefaultsCache(async () => { probes += 1; return probeAnswering({}, []); });
  await cache.ensure("1.21.4", [], example);
  assert.equal(probes, 0);
});

test("defaults are kept per version", async () => {
  const cache = new GameruleDefaultsCache(async () => probeAnswering({ doFireTick: "true" }, []));
  await cache.ensure("1.21.4", ["doFireTick"], example);
  assert.deepEqual(cache.forVersion("1.20.1"), {});
});

test("a rule the server does not know is reported and left out, the others are kept", async () => {
  const cache = new GameruleDefaultsCache(async () => probeAnswering({ doFireTick: "true" }, []));
  const unknown = await cache.ensure("1.21.4", ["doFireTick", "noSuchRule"], example);
  assert.deepEqual(unknown, ["noSuchRule"]);
  assert.deepEqual(cache.forVersion("1.21.4"), { doFireTick: "true" });
});

test("a rule found unknown is asked again the next time (it may be a typo corrected, not a cached fact)", async () => {
  const asked: string[] = [];
  const cache = new GameruleDefaultsCache(async () => probeAnswering({}, asked));
  await cache.ensure("1.21.4", ["noSuchRule"], example);
  await cache.ensure("1.21.4", ["noSuchRule"], example);
  assert.deepEqual(asked, ["noSuchRule", "noSuchRule"]);
});
