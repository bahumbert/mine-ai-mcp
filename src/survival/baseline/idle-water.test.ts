import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { waterFixture } from "../../test-support/water.js";
import { attachIdleWaterControl } from "./idle-water.js";

/** The idle control on a navigation that is moving whenever the test says so (`fixture.setMoving`). */
function controlWhileMoving(fixture: ReturnType<typeof waterFixture>) {
  return attachIdleWaterControl(
    fixture.bot,
    {
      get active() {
        return fixture.isMoving();
      },
      get steering() {
        return fixture.isMoving();
      },
    },
    fixture.reflex.runner,
  );
}

// The working mode (a foreground action standing in water) is in idle-water-working.test.ts.
test("asserts jump while idle in water and releases it once dry", async (t) => {
  const fixture = waterFixture(t);
  const control = attachIdleWaterControl(fixture.bot, { active: false, steering: false }, fixture.reflex.runner);

  fixture.entity.isInWater = true;
  fixture.entity.onGround = false;
  fixture.bot.emit("physicsTick");
  fixture.bot.emit("physicsTick");
  fixture.entity.isInWater = false;
  fixture.entity.onGround = true;
  fixture.bot.emit("physicsTick");

  assert.deepEqual(
    fixture.controls.filter(([control]) => control === "jump"),
    [
      ["jump", true],
      ["jump", true],
      ["jump", false],
    ],
  );

  await control[Symbol.dispose]();
  assert.equal(
    fixture.bot.listenerCount("physicsTick"),
    0,
    "The baseline did not register an unrelated breathing reflex.",
  );
});

test("an idle body resists current after a cancelled interaction and yields to the next owner", async (t) => {
  const fixture = waterFixture(t);
  const control = controlWhileMoving(fixture);
  fixture.entity.isInWater = true;
  fixture.bot.emit("physicsTick");
  fixture.entity.position.x += 0.3;
  fixture.bot.emit("physicsTick");
  assert.ok(fixture.controls.some(([key, active]) => key === "left" && active));
  fixture.setMoving(true);
  const before = fixture.controls.length;
  fixture.bot.emit("physicsTick");
  assert.equal(fixture.controls.length, before, "idle holding must not overwrite the new route's controls");
  await control[Symbol.dispose]();
});

test("relinquishes jump without writing false when Pathfinder starts moving", async (t) => {
  const fixture = waterFixture(t);
  const control = controlWhileMoving(fixture);

  fixture.entity.isInWater = true;
  fixture.entity.onGround = false;
  fixture.bot.emit("physicsTick");
  fixture.setMoving(true);
  fixture.bot.emit("physicsTick");
  await control[Symbol.dispose]();

  assert.deepEqual(
    fixture.controls.filter(([control]) => control === "jump"),
    [["jump", true]],
  );
});

test("observes the current Mineflayer entity rather than retaining a stale one", async (t) => {
  const fixture = waterFixture(t);
  const control = attachIdleWaterControl(fixture.bot, { active: false, steering: false }, fixture.reflex.runner);

  fixture.entity.onGround = false;
  Object.assign(fixture.bot, { entity: { ...fixture.entity, isInWater: true } });
  fixture.bot.emit("physicsTick");
  await control[Symbol.dispose]();

  assert.deepEqual(
    fixture.controls.filter(([control]) => control === "jump"),
    [
      ["jump", true],
      ["jump", false],
    ],
  );
});

test("close releases jump when the attachment still owns it", async (t) => {
  const fixture = waterFixture(t);
  const control = attachIdleWaterControl(fixture.bot, { active: false, steering: false }, fixture.reflex.runner);

  fixture.entity.isInWater = true;
  fixture.entity.onGround = false;
  fixture.bot.emit("physicsTick");
  await control[Symbol.dispose]();
  await control[Symbol.dispose]();

  assert.deepEqual(
    fixture.controls.filter(([control]) => control === "jump"),
    [
      ["jump", true],
      ["jump", false],
    ],
  );
  assert.equal(
    fixture.bot.listenerCount("physicsTick"),
    0,
    "The baseline did not register an unrelated breathing reflex.",
  );
});

/** The jump writes of a fixture, in order. */
const jumpWrites = (fixture: ReturnType<typeof waterFixture>) =>
  fixture.controls.filter(([control]) => control === "jump");

test("an idle body standing on the floor of one-block water presses no jump", async (t) => {
  const fixture = waterFixture(t);
  fixture.harness.world.setCell(new Vec3(0, 64, 0), "water");
  fixture.entity.isInWater = true;
  fixture.entity.onGround = true;
  const control = attachIdleWaterControl(fixture.bot, { active: false, steering: false }, fixture.reflex.runner);

  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  assert.deepEqual(jumpWrites(fixture), [
    ["jump", false],
    ["jump", false],
    ["jump", false],
    ["jump", false],
    ["jump", false],
  ]);

  fixture.entity.position.x += 0.3;
  fixture.bot.emit("physicsTick");
  assert.ok(
    fixture.controls.some(([key, active]) => key === "left" && active),
    "the horizontal hold against a current is kept while standing",
  );
  await control[Symbol.dispose]();
  assert.equal(fixture.bot.listenerCount("physicsTick"), 0);
});

test("a body that left the water while falling presses no jump", async (t) => {
  const fixture = waterFixture(t);
  fixture.harness.world.setCell(new Vec3(0, 64, 0), "water");
  fixture.entity.isInWater = true;
  fixture.entity.onGround = false;
  const control = attachIdleWaterControl(fixture.bot, { active: false, steering: false }, fixture.reflex.runner);

  fixture.bot.emit("physicsTick");
  fixture.entity.isInWater = false;
  fixture.bot.emit("physicsTick");
  assert.deepEqual(jumpWrites(fixture).at(-1), ["jump", false]);
  await control[Symbol.dispose]();
  assert.equal(fixture.bot.listenerCount("physicsTick"), 0);
});

test("an idle body presses jump in water unless it stands on the floor with its eyes out", async (t) => {
  const rows = [
    { onGround: true, eyesInWater: false, jump: false },
    { onGround: true, eyesInWater: true, jump: true },
    { onGround: false, eyesInWater: true, jump: true },
    { onGround: false, eyesInWater: false, jump: true },
  ];
  for (const row of rows) {
    const fixture = waterFixture(t);
    fixture.harness.world.setCell(new Vec3(0, 64, 0), "water");
    if (row.eyesInWater) fixture.harness.world.setCell(new Vec3(0, 65, 0), "water");
    fixture.entity.isInWater = true;
    fixture.entity.onGround = row.onGround;
    const control = attachIdleWaterControl(fixture.bot, { active: false, steering: false }, fixture.reflex.runner);

    fixture.bot.emit("physicsTick");
    assert.deepEqual(jumpWrites(fixture).at(-1), ["jump", row.jump], JSON.stringify(row));
    await control[Symbol.dispose]();
    assert.equal(fixture.bot.listenerCount("physicsTick"), 0, JSON.stringify(row));
  }
});

test("an idle body settles on touching the floor and floats again when it leaves it", async (t) => {
  const fixture = waterFixture(t);
  fixture.harness.world.setCell(new Vec3(0, 64, 0), "water");
  fixture.entity.isInWater = true;
  const control = attachIdleWaterControl(fixture.bot, { active: false, steering: false }, fixture.reflex.runner);

  for (const onGround of [false, true, false, true]) {
    fixture.entity.onGround = onGround;
    fixture.bot.emit("physicsTick");
  }
  assert.deepEqual(jumpWrites(fixture), [
    ["jump", true],
    ["jump", false],
    ["jump", true],
    ["jump", false],
  ]);
  await control[Symbol.dispose]();
  assert.equal(fixture.bot.listenerCount("physicsTick"), 0);
});

test("a route that starts while an idle body stands on the floor is not written over", async (t) => {
  const fixture = waterFixture(t);
  fixture.harness.world.setCell(new Vec3(0, 64, 0), "water");
  fixture.entity.isInWater = true;
  fixture.entity.onGround = true;
  const control = controlWhileMoving(fixture);

  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  assert.ok(
    !jumpWrites(fixture).some(([, active]) => active),
    "standing on the floor writes no jump true (the old code writes it)",
  );

  fixture.setMoving(true);
  const before = fixture.controls.length;
  fixture.bot.emit("physicsTick");
  assert.equal(fixture.controls.length, before, "the route's controls are not written over");

  await control[Symbol.dispose]();
  for (const name of ["jump", "forward", "back", "left", "right"]) {
    const last = fixture.controls.filter(([key]) => key === name).at(-1);
    assert.ok(last, `${name} was written`);
    assert.equal(last[1], false, `${name} is released on dispose`);
  }
  assert.equal(fixture.bot.listenerCount("physicsTick"), 0);
});
