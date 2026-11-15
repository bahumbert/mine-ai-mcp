import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld } from "../../test-support/navigation.js";
import type { PlannedOperation } from "../movements/movement.js";
import { createMovementPolicy } from "../movements/policy.js";
import { breakBlockInPlace } from "./in-place-break.js";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { MineflayerBot, mineflayerBotSurface } from "../mineflayer/bot.js";
import { MineflayerWorldView } from "../mineflayer/world.js";

test("in-place mining preserves liquid refusals on dry ground and only admits water from a still-water stance", async () => {
  for (const submerged of [false, true]) for (const liquid of ["water", "lava"] as const) {
    const world = flatWorld();
    const target = { x: 1, y: 64, z: 0 };
    world.load(target, { stateId: 1 });
    world.load({ x: 2, y: 64, z: 0 }, { stateId: 2, traits: { liquid, liquidSource: true } });
    if (submerged) world.load({ x: 0, y: 64, z: 0 }, { stateId: 2, collisionShapes: [], traits: { liquid: "water", liquidSource: true } });
    const bot = new FakeNavigationBot();
    bot.current = { ...bot.current, position: { x: 0.5, y: 64, z: 0.5 } };
    let attempts = 0;
    bot.startEffect = (operation) => {
      if (operation.kind !== "break") throw new Error("expected a dig");
      attempts++;
      world.load(operation.position, { stateId: 0 });
      return { issued: true, completion: Promise.resolve({ kind: "accepted" }), cancel() {} };
    };
    const policy = createMovementPolicy({
      evaluateBreak(_block, _position, view) {
        const face = view.blockAt(2, 64, 0);
        return {
          decision: face.kind === "loaded" && face.traits.liquid !== null
            ? { kind: "prohibited", cause: "opens_into_liquid", reason: "liquid remains" }
            : { kind: "allowed" },
          tool: { itemType: null, expectedTicks: 1 },
        };
      },
    });
    const permitted = submerged && liquid === "water";
    const result = await breakBlockInPlace({ world, bot }, { position: target, movements: policy });
    assert.equal(result.status, permitted ? "broken" : "failed", `${submerged}, ${liquid}`);
    assert.equal(attempts, permitted ? 1 : 0);
  }
});

test("in-place excavation refuses the buried shaft without issuing a dig", async () => {
  const world = flatWorld();
  const target = { x: 0, y: 65, z: 0 };
  world.load(target, { stateId: 1 });
  for (let y = 66; y <= 70; y += 1) world.load({ x: 0, y, z: 0 }, { stateId: 2, traits: { falling: true } });
  world.load({ x: 0, y: 71, z: 0 }, { stateId: 0 });
  const bot = new FakeNavigationBot();
  let attempts = 0;
  bot.startEffect = () => {
    attempts += 1;
    throw new Error("unsafe dig issued");
  };
  const result = await breakBlockInPlace({ world, bot }, { position: target, movements: createMovementPolicy() });
  assert.equal(result.status, "failed");
  assert.equal(attempts, 0);
});

test("cancellation between column digs leaves the remaining support intact", async () => {
  const world = flatWorld();
  const target = { x: 1, y: 63, z: 0 };
  world.load(target, { stateId: 1 });
  world.load({ x: 1, y: 64, z: 0 }, { stateId: 2, traits: { falling: true } });
  const bot = new FakeNavigationBot();
  const controller = new AbortController();
  const dug: number[] = [];
  bot.startEffect = (operation: Exclude<PlannedOperation, { kind: "move" }>) => {
    if (operation.kind !== "break") throw new Error("expected dig");
    dug.push(operation.position.y);
    world.load(operation.position, { stateId: 0 });
    controller.abort(new Error("cancel excavation"));
    return { issued: true, completion: Promise.resolve({ kind: "accepted" }), cancel() {} };
  };
  await assert.rejects(
    breakBlockInPlace(
      { world, bot },
      { position: target, movements: createMovementPolicy(), signal: controller.signal },
    ),
    /cancel excavation/,
  );
  assert.deepEqual(dug, [64]);
  const support = world.blockAt(1, 63, 0);
  assert.equal(support.kind === "loaded" && support.stateId, 1);
});

test("cancelling an in-place dig stops the physical effect before releasing the body", async () => {
  const world = flatWorld();
  const target = { x: 1, y: 63, z: 0 };
  world.load(target, { stateId: 1 });
  const bot = new FakeNavigationBot();
  const controller = new AbortController();
  let cancelled = false;
  bot.startEffect = () => {
    let finish!: (value: { kind: "failed"; observation: string }) => void;
    const completion = new Promise<{ kind: "failed"; observation: string }>((resolve) => {
      finish = resolve;
    });
    queueMicrotask(() => controller.abort(new Error("stop mining in current")));
    return {
      issued: true,
      completion,
      cancel() {
        cancelled = true;
        finish({ kind: "failed", observation: "Dig cancelled" });
      },
    };
  };
  const work = breakBlockInPlace(
    { world, bot },
    { position: target, movements: createMovementPolicy(), signal: controller.signal },
  );
  const rejected = assert.rejects(work, /stop mining in current/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true, "aborting must stop the active dig, not only its positioning controls");
  await rejected;
});

test("in-place column landing with a stopped clock fails; after resume the next in-place break clears it", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const fake = createFakeBot({ clock, server: { ticksPerSecond: 5 }, cells: {
    "0,66,0": "bedrock", "1,66,0": "bedrock",
    "2,65,0": "sand", "2,66,0": "sand", "2,67,0": "sand",
  } });
  using _clock = clock.install();
  const cell = new Vec3(2, 65, 0);
  const world = new MineflayerWorldView(fake.bot);
  const bot = new MineflayerBot(mineflayerBotSurface(fake.bot), world);
  const options = { position: cell, movements: createMovementPolicy() };
  const packet = (state: string) => {
    fake.world.setCell(cell, state);
    fake.bot._client.emit("block_change", { location: cell, type: fake.world.blockAt(cell)!.stateId });
  };
  clock.after(1_000, () => { packet("air"); fake.server.stop(); });
  try {
    const first = await clock.settle(breakBlockInPlace({ bot, world }, options), 21_100, 25);
    assert.equal(first.status, "failed");
    assert.match(first.status === "failed" ? first.reason : "", /server clock stood still.*column/);
    fake.server.resume();
    fake.world.setCell(new Vec3(2, 66, 0), "air");
    fake.world.setCell(new Vec3(2, 67, 0), "air");
    packet("sand");
    const stop = fake.server.onPacket("block_dig", data => {
      if ((data as { status: number }).status === 2) fake.server.answer(() => packet("air"));
    });
    try {
      assert.deepEqual(await clock.settle(breakBlockInPlace({ bot, world }, options), 10_000), { status: "broken" });
      assert.equal(fake.world.blockAt(cell)!.stateId, 0);
    } finally { stop(); }
  } finally { world.close(); }
});
