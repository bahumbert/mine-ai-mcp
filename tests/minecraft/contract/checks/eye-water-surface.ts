// The standing eye crosses a source surface without changing the eye block.
import assert from "node:assert/strict";
import type { Vec3 } from "vec3";
import { airSupplyTicks } from "../../../../src/world/air-supply.ts";
import { observedEyeHeight, STANDING_EYE_HEIGHT } from "../../../../src/world/block-visibility.ts";
import { botEyesInWater, hasQualifiedEyeWaterSample } from "../../../../src/world/eyes-in-water.ts";
import type { ContractCheck } from "../checks.ts";
import { serverQuiet } from "../server-answer.ts";
import { SERVER_FEET_TOLERANCE, waitForBodyReply } from "../subject-position.ts";
import type { ContractSubject } from "../subject.ts";

const DRY = [0.5, -58.644, 0.5] as const;
const WET = [0.5, -58.76, 0.5] as const;
const FULL_AIR = 300;

/** Query the server and reject any drift from the intended probe position. */
async function readAt(subject: ContractSubject, expected: Vec3, phase: string) {
  const body = await subject.readBodyOnServer();
  const matches = (["x", "y", "z"] as const).every((axis) => Math.abs(body.feet[axis] - expected[axis]) <= SERVER_FEET_TOLERANCE);
  assert.ok(matches, `${phase}: server feet ${body.feet} drifted from ${expected}`);
  assert.ok(hasQualifiedEyeWaterSample(subject.bot) && observedEyeHeight(subject.bot.entity) === STANDING_EYE_HEIGHT,
    `${phase}: probe did not keep an unmounted standing body`);
  return body;
}

/** Keep a full meter at the fixed dry point through a window that could have delivered air. */
async function dryWindow(subject: ContractSubject, feet: Vec3, seen: readonly (number | null)[], from: number, phase: string) {
  const first = await readAt(subject, feet, phase);
  assert.equal(first.air, FULL_AIR, `${phase}: server air ${first.air} at ${first.feet}, packets ${seen.slice(from)}`);
  await serverQuiet(subject, phase);
  const last = await readAt(subject, feet, phase);
  assert.equal(last.air, FULL_AIR, `${phase}: server air after quiet at ${last.feet}`);
  assert.deepEqual(seen.slice(from), [], `${phase}: own air metadata above the source`);
  return last;
}

export const eyeWaterSurface: ContractCheck = {
  name: "eye-water-surface",
  withoutRuntime: true,
  fakeTickRates: [20, 10],
  fixture: {
    position: [-2.5, -60, 0.5],
    cells: {
      ...Object.fromEntries([-60, -59, -58].flatMap((y) => [
        [`-1,${y},0`, "glass"], [`1,${y},0`, "glass"], [`0,${y},-1`, "glass"], [`0,${y},1`, "glass"],
      ])),
      "0,-60,0": { name: "water", properties: { level: 0 } },
      "0,-59,0": { name: "water", properties: { level: 0 } },
      "0,-58,0": { name: "water", properties: { level: 0 } },
    },
    carried: {},
  },
  async run(subject) {
    const { bot } = subject;
    const seen: (number | null)[] = [];
    const onBreath = () => void seen.push(airSupplyTicks(bot));
    using _motion = subject.holdBodyStill();
    bot.on("breath", onBreath);
    try {
      const top = subject.world([0, -58, 0]);
      assert.ok(await subject.blockIs(top, "water", { level: 0 }), "top water on the server is not a source");
      assert.ok(await subject.blockIs(top.offset(0, 1, 0), "air"), "server cell above source is not air");

      const dry = subject.world(DRY);
      const dryStart = seen.length;
      await subject.teleportFeet(dry);
      const dryAge = bot.time.age;
      const dryAt = subject.now();
      const dryBody = await dryWindow(subject, dry, seen, dryStart, "dry entry");
      const dryPace = `${dryAge}→${bot.time.age} in ${Math.round(subject.now() - dryAt)}ms`;
      const dryPredicate = botEyesInWater(bot);
      assert.equal(dryPredicate, false, `predicate above the source surface at ${dryBody.feet}; server Air=${dryBody.air}, own packets=0, age ${dryPace}`);

      const wet = subject.world(WET);
      const wetStart = seen.length;
      await subject.teleportFeet(wet);
      await waitForBodyReply(bot, subject, () => seen.length > wetStart);
      assert.equal(seen[wetStart], 299, "first own air packet below the surface");
      const wetBody = await readAt(subject, wet, "wet");
      assert.ok(wetBody.air < FULL_AIR, `wet: server still has full air at ${wetBody.feet}`);
      assert.ok(botEyesInWater(bot), "predicate below the source surface");

      const returnStart = seen.length;
      await subject.teleportFeet(dry);
      const fullIndex = () => seen.indexOf(FULL_AIR, returnStart);
      await waitForBodyReply(bot, subject, () => fullIndex() >= 0);
      const returnBody = await dryWindow(subject, dry, seen, fullIndex() + 1, "dry return");
      assert.equal(botEyesInWater(bot), false, "predicate above the surface after refill");
      return `dry ${dryBody.feet} air=${dryBody.air}, packets=0, predicate=${dryPredicate}, age ${dryPace}; wet ${wetBody.feet} air=${wetBody.air}, first=${seen[wetStart]}; return ${returnBody.feet} air=${returnBody.air}, packets after 300=0`;
    } finally {
      bot.off("breath", onBreath);
    }
  },
};
