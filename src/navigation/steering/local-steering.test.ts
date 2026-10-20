import assert from "node:assert/strict";
import test from "node:test";
import {
  centerOnCell,
  driveHorizontalSteering,
  type HorizontalSteeringControl,
  type HorizontalSteeringPort,
} from "./local-steering.js";

/**
 * A body that only moves when a tick says so. `held` is what the steering owns
 * at that moment, `asserted` every control it ever pressed, which is how a
 * release is told from a control that was never taken.
 */
function steeringPort(
  position: { x: number; y: number; z: number },
  onTick: (held: ReadonlySet<HorizontalSteeringControl>) => void,
) {
  const held = new Set<HorizontalSteeringControl>();
  const asserted: HorizontalSteeringControl[] = [];
  const port: HorizontalSteeringPort = {
    observe: () => ({ position, yaw: -Math.PI / 2 }),
    setControl: (control, state) => {
      if (state) {
        held.add(control);
        asserted.push(control);
      } else {
        held.delete(control);
      }
    },
    waitForTick: async () => onTick(held),
  };
  return { port, held, asserted };
}

test("centering corrects inherited momentum that carries the body back outside the arrival radius", async () => {
  const position = { x: 0.28, y: 64, z: 0.5 };
  let velocity = 0.25;
  const { port, held } = steeringPort(position, (control) => {
    velocity = (velocity + (control.has("forward") ? 0.1 : control.has("back") ? -0.1 : 0)) * 0.546;
    position.x += velocity;
  });

  assert.equal(await centerOnCell(port, { x: 0, y: 64, z: 0 }, new AbortController().signal), true);
  assert.ok(Math.abs(position.x - 0.5) <= 0.17);
  assert.equal(held.size, 0);
});

test("local steering reads a moving target every tick and releases every control", async () => {
  const position = { x: 0, y: 64, z: 0 };
  let targetX = 1;
  let targetReads = 0;
  let ticks = 0;
  const { port, held, asserted } = steeringPort(position, () => {
    ticks += 1;
    if (ticks === 1) targetX = -1;
  });

  const outcome = await driveHorizontalSteering(port, {
    target: () => {
      targetReads += 1;
      return { x: targetX, y: 64, z: 0 };
    },
    arrived: () => false,
    maximumTicks: 2,
    signal: new AbortController().signal,
  });

  assert.deepEqual(outcome, { kind: "exhausted", ticks: 2 });
  assert.ok(targetReads >= 3);
  assert.ok(asserted.includes("forward"));
  assert.ok(asserted.includes("back"));
  assert.equal(held.size, 0);
});

test("local steering settles from the caller's arrival fact", async () => {
  const position = { x: 0, y: 64, z: 0 };
  const { port, held } = steeringPort(position, (control) => {
    if (control.has("forward")) position.x += 0.4;
  });

  const outcome = await driveHorizontalSteering(port, {
    target: () => ({ x: 1, y: 64, z: 0 }),
    arrived: () => position.x >= 0.8,
    maximumTicks: 5,
    signal: new AbortController().signal,
  });

  assert.deepEqual(outcome, { kind: "arrived" });
  assert.equal(held.size, 0);
});

/** A port whose physics stopped: no tick ever comes. */
function silentPort() {
  const { port, held, asserted } = steeringPort({ x: 0, y: 64, z: 0 }, () => undefined);
  port.waitForTick = () => new Promise<void>(() => undefined);
  return { port, held, asserted };
}

test("an abort while no tick comes ends the drive at once", async () => {
  const { port, held, asserted } = silentPort();
  const abort = new AbortController();
  const driving = driveHorizontalSteering(port, {
    target: () => ({ x: 5, y: 64, z: 0 }),
    arrived: () => false,
    maximumTicks: 100,
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(new Error("run stopped")), 20);
  const startedAt = performance.now();
  await assert.rejects(driving, /run stopped/);
  assert.ok(performance.now() - startedAt < 500);
  assert.ok(asserted.length > 0, "the drive had taken controls");
  assert.equal(held.size, 0);
});

test("a drive whose ticks stop ends exhausted within its wall bound, every control released", async () => {
  const { port, held, asserted } = silentPort();
  const startedAt = performance.now();
  const outcome = await driveHorizontalSteering(port, {
    target: () => ({ x: 5, y: 64, z: 0 }),
    arrived: () => false,
    maximumTicks: 2,
    signal: new AbortController().signal,
  });
  const waited = performance.now() - startedAt;
  assert.deepEqual(outcome, { kind: "exhausted", ticks: 2 });
  // 2 ticks are 100 ms of physics; the drive adds one second of slack before it reads physics as stopped.
  assert.ok(waited >= 1_000 && waited < 2_500, `ended after ${waited} ms`);
  assert.ok(asserted.length > 0);
  assert.equal(held.size, 0);
});
