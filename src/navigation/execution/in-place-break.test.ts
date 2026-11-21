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

test("in-place support refusal keeps its cause and support flag on every column dig; the next bank break succeeds", async () => {
  const world = flatWorld();
  const position = { x: 1, y: 63, z: 0 };
  world.load(position, { stateId: 1 });
  world.load({ x: 1, y: 64, z: 0 }, { stateId: 2, traits: { falling: true } });
  const bot = new FakeNavigationBot();
  const retained: (boolean | undefined)[] = [];
  let refuse = true;
  bot.startEffect = (operation) => {
    assert.equal(operation.kind, "break");
    if (operation.kind !== "break") throw new Error("expected a dig");
    retained.push(operation.retainSupport);
    if (refuse && operation.position.y === 63) return {
      issued: false, cancel() {},
      completion: Promise.resolve({ kind: "failed", observation: "Move onto the bank.", cause: "support" }),
    };
    world.load(operation.position, { stateId: 0 });
    return { issued: true, cancel() {}, completion: Promise.resolve({ kind: "accepted" }) };
  };
  const options = { position, movements: createMovementPolicy(), retainSupport: true };
  assert.deepEqual(await breakBlockInPlace({ world, bot }, options), {
    status: "failed", reason: "Move onto the bank.", cause: "support",
  });
  assert.deepEqual(retained, [true, true]);
  refuse = false;
  bot.current = { ...bot.current, position: { x: 2.5, y: 64, z: 0.5 } };
  assert.deepEqual(await breakBlockInPlace({ world, bot }, options), { status: "broken" });
});

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

test("an in-place break names the cause of each refusal: a stance-local one is `stance`, a policy one `policy`, a target-wide one none (D39)", async () => {
  const issued: string[] = [];
  const bot = new FakeNavigationBot();
  bot.current = { ...bot.current, position: { x: 0.5, y: 64, z: 0.5 } };
  bot.startEffect = (operation) => {
    issued.push(operation.kind);
    throw new Error("no dig is issued for a refused preparation");
  };

  // Hidden behind a two-high wall: the preparation refuses this stance's sight, with the preparation's own reason.
  const hidden = flatWorld();
  const target = { x: 2, y: 64, z: 0 };
  hidden.load(target, { stateId: 1 });
  for (const y of [64, 65]) hidden.load({ x: 1, y, z: 0 }, { stateId: 3 });
  const behindWall = await breakBlockInPlace({ world: hidden, bot }, { position: target, movements: createMovementPolicy() });
  assert.equal(behindWall.status, "failed");
  assert.match(behindWall.status === "failed" ? behindWall.reason : "", /cannot be seen within reach/);
  assert.equal(behindWall.status === "failed" ? behindWall.cause : "broken", "stance");

  // Not loaded: the block, not the stance.
  const unloaded = await breakBlockInPlace({ world: flatWorld(), bot }, { position: { x: 40, y: 64, z: 40 }, movements: createMovementPolicy() });
  assert.deepEqual(unloaded, { status: "failed", reason: "The block is not loaded." });

  // Digging disabled and a prohibited break at the price: the block, from every cell.
  const open = flatWorld();
  open.load({ x: 1, y: 64, z: 0 }, { stateId: 1 });
  const disabled = await breakBlockInPlace({ world: open, bot }, {
    position: { x: 1, y: 64, z: 0 }, movements: createMovementPolicy({ allowDigging: false }),
  });
  assert.equal(disabled.status === "failed" ? disabled.cause : "broken", undefined);
  const prohibited = createMovementPolicy({
    evaluateBreak: () => ({ decision: { kind: "prohibited", reason: "never here" }, tool: { itemType: null, expectedTicks: 1 } }),
  });
  const refused = await breakBlockInPlace({ world: open, bot }, { position: { x: 1, y: 64, z: 0 }, movements: prohibited });
  assert.deepEqual(refused, { status: "failed", reason: "never here" });
  assert.deepEqual(issued, []);
});

test("an in-place break keeps the cause of a failing dig: `stance` and `support` from the effect, `policy` from a refusal mid-excavation", async () => {
  const world = flatWorld();
  const position = { x: 1, y: 64, z: 0 };
  world.load(position, { stateId: 1 });
  const bot = new FakeNavigationBot();
  bot.current = { ...bot.current, position: { x: 0.5, y: 64, z: 0.5 } };
  const results: unknown[] = [];
  for (const cause of ["stance", "support"] as const) {
    bot.startEffect = () => ({
      issued: false, cancel() {},
      completion: Promise.resolve({ kind: "failed", observation: `The ${cause} refused it.`, cause }),
    });
    results.push(await breakBlockInPlace({ world, bot }, { position, movements: createMovementPolicy() }));
  }
  assert.deepEqual(results, [
    { status: "failed", reason: "The stance refused it.", cause: "stance" },
    { status: "failed", reason: "The support refused it.", cause: "support" },
  ]);

  // A policy that refuses the dig only once the excavation is under way (the cell's neighbours changed): `policy`.
  let evaluations = 0;
  const lateRefusal = createMovementPolicy({
    evaluateBreak: () => ({
      decision: ++evaluations > 1 ? { kind: "prohibited", reason: "opens into liquid now" } : { kind: "allowed" },
      tool: { itemType: null, expectedTicks: 1 },
    }),
  });
  bot.startEffect = () => { throw new Error("a prohibited dig must not be issued"); };
  assert.deepEqual(
    await breakBlockInPlace({ world, bot }, { position, movements: lateRefusal }),
    { status: "failed", reason: "opens into liquid now", cause: "policy" },
  );
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

for (const rate of [5, 10]) test(`in-place column landing with a stopped clock fails; after resume at ${rate} tps the next in-place break clears it`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const fake = createFakeBot({ clock, server: { ticksPerSecond: rate }, cells: {
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
  let stoppedAge = 0;
  clock.after(1_000, () => { packet("air"); stoppedAge = fake.bot.time.age; fake.server.stop(); });
  try {
    const first = await clock.settle(breakBlockInPlace({ bot, world }, options), 21_100, 25);
    assert.equal(fake.bot.time.age, stoppedAge);
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
