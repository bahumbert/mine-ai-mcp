import { openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "../../src/scenario-client.ts";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import {
  dragonDanger,
  incomingDragonBodies,
  perchedDragonContact,
  readDragonClouds,
} from "../../../src/world/dragon-hazards.ts";
import { waitForServerPaced } from "../../../src/world/server-paced.ts";

// Cause E of the crystals-bow reds (analysis 2026-11-21-end-runtime-closed-analysis): the driver succeeds, its runtime
// closes while the dragon reflex is evading, and the close used to fail the met scenario. A staged cloud under an idle
// bot makes the evade start on demand, so the close lands on it every run instead of 1 run in 16.
const start = { x: -1.5, y: 65, z: 3.5 };
const dragonAt = { x: 0, y: 110, z: -80 };
const moved = 0.5;
const within = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, distance: number) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= distance;

export const prepare: MineAiScenarioPreparation = async (context) => {
  const { bot, signal } = context;
  await wearArmor(context);
  const dragonSeen = await waitForServerPaced(bot, 400, {
    signal,
    until: () => bot.nearestEntity((entity) => entity.name === "ender_dragon") !== null,
  });
  if (dragonSeen !== "until") throw new Error(`No dragon to stage (${dragonSeen})`);
  bot.chat(`/data merge entity @e[type=ender_dragon,limit=1] {NoAI:1b,Pos:[${dragonAt.x}d,${dragonAt.y}d,${dragonAt.z}d],Motion:[0d,0d,0d]}`);
  bot.chat("/kill @e[type=enderman]");
  bot.chat(`/tp @s ${start.x} ${start.y} ${start.z}`);
  // No effects: the bot is not hurt. The reflex reads only the particle type and the radius (`dragon-hazards.ts`). The
  // radius is not the default 3: with `Radius:3.0f` the staging check failed live (close-during-evade, 10 tps, 2026-11-21:
  // the cloud's metadata held its particle and no radius, so `readDragonClouds` read none); 4.0 is sent, as `landing-idle-escape` stages.
  bot.chat(`/summon area_effect_cloud ${start.x} ${start.y} ${start.z} {Radius:4.0f,Duration:600,WaitTime:0,Particle:{type:"minecraft:dragon_breath"}}`);
  const scene = () => {
    const dragon = bot.nearestEntity((entity) => entity.name === "ender_dragon");
    return {
      oneCloud: readDragonClouds(bot).length === 1,
      danger: dragonDanger(bot),
      dragonStaged: dragon !== null && within(dragon.position, dragonAt, 0.5),
      noIncomingBody: incomingDragonBodies(bot).length === 0,
      noPerchContact: !perchedDragonContact(bot, bot.entity.position),
      botAtStart: within(bot.entity.position, start, 0.1),
      onGround: bot.entity.onGround,
      health: bot.health === 20,
    };
  };
  const staged = await waitForServerPaced(bot, 100, { signal, until: () => Object.values(scene()).every(Boolean) });
  if (staged !== "until") throw new Error(`Close scene was not acknowledged (${staged}): ${JSON.stringify(scene())}`);
  context.log(JSON.stringify({ staged: { bot: bot.entity.position, clouds: readDragonClouds(bot) } }));
};

export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, signal } = context;
  await using runtime = await openRuntime(context, "close-during-evade");
  const evading = () =>
    runtime.status().survival.owner.current === "dragon_reflex" &&
    Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z) >= moved;
  const claimed = await waitForServerPaced(bot, 200, { signal, until: evading });
  if (claimed !== "until") return { status: "failed", detail: `the dragon reflex never moved the bot (${claimed})` };
  // The same synchronous turn: the close runs at the scope's end, with the evade still live.
  const closingWith = runtime.status().survival.owner.current;
  const distance = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z);
  context.log(JSON.stringify({ closingWith, distance, worldAge: bot.time.age }));
  if (closingWith !== "dragon_reflex") return { status: "failed", detail: "the evade ended before the close" };
  return { status: "succeeded" };
};
