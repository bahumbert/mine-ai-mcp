// Watch the declared ghast's first charge or loss after the basalt release.
import type { Entity } from "prismarine-entity";
import { entityMetadata } from "../../../../src/world/end-fight.ts";
import { observeIdleWindow } from "../../../flat/combat/idle-reflex-window.ts";
import type { MineAiScenarioContext } from "../../../src/scenario-client.ts";

type Bot = MineAiScenarioContext["bot"];

interface GhastSample {
  age: number | null;
  dy: number;
  distance: number;
}

type ChargeEnd = { kind: "charged"; age: number | null } | { kind: "lost"; lastSeen: GhastSample };

interface GhastCharge {
  readonly ghast: Entity;
  readonly end: ChargeEnd | null;
  readonly samples: GhastSample[];
  stop(): void;
}

/**
 * Two times the longest measured native charge (260 ticks at 10 tps, a7 T4 t00067), rounded to 20.
 * The staged-release probe for a2 T13b saw 0–40 ticks over ten runs at 20 and 10 tps.
 */
const GHAST_CHARGE_TICKS = 520;

/** Read the last available position of the ghast and its separation from the bot. */
function sampleGhast(bot: Bot, ghast: Entity): GhastSample {
  const position = bot.entity.position;
  return {
    age: bot.time.age,
    dy: Math.abs(ghast.position.y - position.y),
    distance: position.distanceTo(ghast.position),
  };
}

/** Arm before release so a charge followed immediately by loss still counts as a charge. */
export function watchGhastCharge(bot: Bot): GhastCharge {
  const ghast = Object.values(bot.entities).find((entity) => entity.name === "ghast" && entity.isValid);
  if (!ghast) throw new Error("The declared ghast is not in the basalt arena.");
  const chargingKey = "is_charging";
  if (!bot.registry.entitiesByName.ghast?.metadataKeys?.includes(chargingKey))
    throw new Error("minecraft-data has no is_charging metadata key for the ghast.");

  const isCharging = (entity: Entity) => entityMetadata(bot, entity, chargingKey) === true;
  let end: ChargeEnd | null = isCharging(ghast) ? { kind: "charged", age: bot.time.age } : null;
  let stopped = false;
  const samples: GhastSample[] = [];
  const onUpdate = (entity: Entity) => {
    if (end === null && entity.id === ghast.id && isCharging(entity)) {
      end = { kind: "charged", age: bot.time.age };
    }
  };
  const onLoss = (entity: Entity) => {
    if (end === null && entity.id === ghast.id) end = { kind: "lost", lastSeen: sampleGhast(bot, entity) };
  };
  const onTime = () => { if (end === null) samples.push(sampleGhast(bot, ghast)); };
  bot.on("entityUpdate", onUpdate);
  bot.on("entityDead", onLoss);
  bot.on("entityGone", onLoss);
  bot.on("time", onTime);
  return {
    ghast,
    get end() { return end; },
    samples,
    stop() {
      if (stopped) return;
      stopped = true;
      bot.off("entityUpdate", onUpdate);
      bot.off("entityDead", onLoss);
      bot.off("entityGone", onLoss);
      bot.off("time", onTime);
    },
  };
}

/** Resolve after the first charge, loss or server-tick budget, releasing the watch on every exit. */
export async function awaitGhastCharge(
  bot: Bot,
  watch: GhastCharge,
  releaseAge: number | null,
  signal: AbortSignal,
  log: MineAiScenarioContext["log"],
): Promise<{ chargeTicks: number | null } | { failure: string }> {
  try {
    await observeIdleWindow(bot, GHAST_CHARGE_TICKS, () => watch.end !== null, signal);
    const end = watch.end;
    if (end?.kind === "charged") {
      const chargeTicks = end.age === null || releaseAge === null ? null : Math.max(0, end.age - releaseAge);
      log(`Ghast charge latched at server age ${end.age}: chargeTicks ${chargeTicks}`);
      return { chargeTicks };
    }
    const lastSeen = end?.lastSeen ?? sampleGhast(bot, watch.ghast);
    const separation = `dy ${lastSeen.dy.toFixed(1)}, distance ${lastSeen.distance.toFixed(1)}`;
    const error = end?.kind === "lost"
      ? `ghast lost before charging (id ${watch.ghast.id}, age ${lastSeen.age}, ${separation})`
      : `ghast did not charge within ${GHAST_CHARGE_TICKS} server ticks (${separation})`;
    return { failure: JSON.stringify({ error, ghastId: watch.ghast.id, lastSeen, chargeSamples: watch.samples }) };
  } finally {
    watch.stop();
  }
}
