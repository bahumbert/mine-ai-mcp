import type { Bot } from "mineflayer";
import type { WorldView } from "../../navigation/index.js";
import { advancingLavaAt } from "../../world/lava-flow.js";
import type { ReflexDriver } from "../control/driver.js";
import { isBurning, isInFire, isInLava } from "../perception/body.js";
import { decideFireResponse, type FireFacts } from "../policy/environment.js";
import { FIRE_ESCAPE_RADIUS, nearbyFireEscape, type FireEscapeReason } from "../positioning/fire-escape.js";
import { escapeFire, type FireEscapeOutcome } from "../responses/fire.js";

/**
 * Whether an escape is reachable, searched once per body position, world revision and danger: the search reads up to
 * a few thousand cells and the reflex senses every tick (20 burning bots). The exact position is the key: a hop
 * from the edge of a bank is admitted or refused by where the body's width reaches (live 2026-10-19).
 */
function escapeAvailability(bot: Bot, world: WorldView) {
  let memo: { key: string; available: boolean } | null = null;
  return (reason: FireEscapeReason, inLava: boolean, inFire: boolean): boolean => {
    const key = `${bot.entity.position}|${world.revision}|${reason}|${inLava}|${inFire}`;
    if (memo?.key !== key) memo = { key, available: nearbyFireEscape(bot, world, reason) !== null };
    return memo.available;
  };
}

/** The facts a fire escape reads: exactly the primitive's search volume (floor and head included), the body, the blocks carried. */
function fireEscapeFacts(bot: Bot) {
  const origin = bot.entity.position.floored();
  const cells: (number | null)[] = [];
  for (let x = -FIRE_ESCAPE_RADIUS; x <= FIRE_ESCAPE_RADIUS; x++)
    for (let z = -FIRE_ESCAPE_RADIUS; z <= FIRE_ESCAPE_RADIUS; z++)
      for (let y = -2; y <= 2; y++) cells.push(bot.blockAt(origin.offset(x, y, z))?.stateId ?? null);
  return {
    cells,
    body: { inLava: isInLava(bot), inFire: isInFire(bot), onGround: bot.entity.onGround },
    blocks: bot.inventory
      .items()
      .filter((item) => bot.registry.blocksByName[item.name])
      .map((item) => ({ name: item.name, count: item.count })),
  };
}

function reflexOutcomeKind(outcome: FireEscapeOutcome) {
  if (outcome === "escaped") return "dry_footing" as const;
  if (outcome === "died") return "bot_died" as const;
  return outcome === "timed_out" ? ("escape_timed_out" as const) : ("no_escape" as const);
}

/** What the model is told when the escape ended without safe footing: no way to go, or out of time on the wall clock. */
function fireEscapeFailure(kind: ReturnType<typeof reflexOutcomeKind>) {
  if (kind === "escape_timed_out")
    return { kind: "no_escape" as const, why: "The fire escape ran out of time before the body reached safe footing." };
  return kind === "no_escape"
    ? { kind: "no_escape" as const, why: "No supported local escape was observed." }
    : null;
}

/** Fire owns its environmental authority; combat policy cannot prohibit escape. */
export function attachFireReflex(bot: Bot, driver: ReflexDriver, world: WorldView): AsyncDisposable {
  let advancing = false;
  const escapeAvailable = escapeAvailability(bot, world);
  const blockUpdate = (before: ReturnType<Bot["blockAt"]>, after: ReturnType<Bot["blockAt"]>) => {
    if (
      after?.name === "lava" &&
      before?.stateId !== after.stateId &&
      advancingLavaAt(bot, bot.entity.position, after.position)
    )
      advancing = true;
  };
  bot.on("blockUpdate", blockUpdate);
  const registration = driver.register({
    name: "fire_reflex",
    sense: () => {
      advancing &&= advancingLavaAt(bot);
      const inLava = isInLava(bot);
      const inFire = isInFire(bot);
      const burning = isBurning(bot);
      if (!advancing && !inLava && !inFire && !burning) return null;
      const reason: FireEscapeReason = advancing ? "advancing_lava" : "contact";
      const facts: FireFacts = {
        reason,
        advancing,
        inLava,
        inFire,
        burning,
        escapeAvailable: escapeAvailable(reason, inLava, inFire),
      };
      return { kind: "observed", danger: facts, evidence: { ...facts } };
    },
    decide: decideFireResponse,
    facts: () => {
      const origin = bot.entity.position.floored();
      return {
        capability: "fire",
        response: "escape_fire",
        scope: `cell:${origin}`,
        permissions: () => null,
        facts: () => fireEscapeFacts(bot),
      };
    },
    act: async (reason, signal) => {
      const healthBefore = bot.health;
      const outcome = await escapeFire(bot, world, signal, reason);
      return {
        kind: reflexOutcomeKind(outcome),
        healthBefore,
        healthAfter: bot.health,
        burning: isBurning(bot),
        inFire: isInFire(bot),
        inLava: isInLava(bot),
        position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      };
    },
    // Resumable requests re-observe their checkpoint after the old physical
    // execution releases. A successful escape must not abandon their goal.
    continuation: (outcome) =>
      outcome.kind === "dry_footing"
        ? { kind: "resume" }
        : { kind: "return", reason: "Fire escape did not establish safe footing." },
    failure: (outcome) => fireEscapeFailure(outcome.kind),
    describe: (outcome) => outcome,
  });
  return {
    async [Symbol.asyncDispose]() {
      bot.off("blockUpdate", blockUpdate);
      await registration[Symbol.asyncDispose]();
    },
  };
}
