import test from "node:test";
import { bowDrawAndRelease } from "./bow-draw-and-release.ts";
import { runOnFake } from "./run-on-fake.ts";

test("bow-draw-and-release tells a short draw from a shot one in server ticks: servers at 20, 14 and 8 ticks a second pass", async () => {
  for (const ticksPerSecond of [20, 14, 8]) await runOnFake(bowDrawAndRelease, { ticksPerSecond });
});

test("bow-draw-and-release holds when the server stalls for 1 s and catches up, in the shot draw", async () => {
  for (const atMs of [200, 700]) await runOnFake(bowDrawAndRelease, {}, undefined, [{ atMs, ms: 1_000 }]);
});
