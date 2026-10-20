import type { Bot } from "mineflayer";
import type { WorldView } from "../../navigation/index.js";
import { advancingLavaAt, lavaChangedNear } from "../../world/lava-flow.js";
import { LETHAL_REFLEX_RETRY_MS } from "../control/contract.js";
import type { ReflexDriver } from "../control/driver.js";
import { isBurning, isInFire, isInLava } from "../perception/body.js";
import { decideFireResponse, type FireFacts } from "../policy/environment.js";
import { FIRE_ESCAPE_RADIUS, nearbyFireEscape, type FireEscapeReason } from "../positioning/fire-escape.js";
import type { FireEscapeOutcome } from "../responses/fire.js";
import { escapeThenSettle, type EscapeAndSettle } from "../responses/lava-settle.js";

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

/** The outcome of the wait for nearby lava to stop spreading, after an escape onto dry ground. */
function lavaWaitOutcomeKind(settle: NonNullable<EscapeAndSettle["settle"]>) {
  if (settle === "settled") return "dry_footing" as const;
  if (settle === "died") return "bot_died" as const;
  return settle === "spreading" ? ("lava_spreading" as const) : ("lava_endangered" as const);
}

/** Why the interrupted action was stopped rather than resumed, for each outcome that ended the escape without a resume. */
function stoppedActionReason(kind: ReturnType<typeof reflexOutcomeKind> | ReturnType<typeof lavaWaitOutcomeKind>) {
  if (kind === "lava_spreading")
    return "Got out of the fire onto safe ground, but lava within 4 blocks was still spreading 10 s later, so the action was stopped instead of walking back into it. Wait for the lava to stop moving, or go another way.";
  if (kind === "lava_endangered")
    return "Got out of the fire onto safe ground, but while waiting for nearby lava to settle the bot was in danger again (damage taken or air running low), so the action was stopped.";
  return "Fire escape did not establish safe footing.";
}

/** What the model is told when the escape ended without safe footing: no way to go, or out of time on the wall clock. */
function fireEscapeFailure(kind: ReturnType<typeof reflexOutcomeKind> | ReturnType<typeof lavaWaitOutcomeKind>) {
  if (kind === "escape_timed_out")
    return { kind: "no_escape" as const, why: "The fire escape ran out of time before the body reached safe footing." };
  return kind === "no_escape"
    ? { kind: "no_escape" as const, why: "No supported local escape was observed." }
    : null;
}

/** What the block updates told the fire reflex: lava spreading toward the body, and when lava last changed nearby. */
interface LavaWatch {
  advancing: boolean;
  /** World age of the latest lava change in the escape's scan volume: the action resumes once it is old enough. */
  lastChangeAge: number | null;
}

/**
 * A packet handler: a throw (an unloaded chunk read while the world changes) must not leave the emit, and changes no
 * state; the next tick's sense reads the world again.
 */
function observeLavaUpdate(bot: Bot, lava: LavaWatch, before: ReturnType<Bot["blockAt"]>, after: ReturnType<Bot["blockAt"]>) {
  try {
    const changedAge = lavaChangedNear(bot, before, after, FIRE_ESCAPE_RADIUS) ? bot.time.age : lava.lastChangeAge;
    const nowAdvancing =
      after?.name === "lava" &&
      before?.stateId !== after.stateId &&
      advancingLavaAt(bot, bot.entity.position, after.position);
    lava.lastChangeAge = changedAge;
    if (nowAdvancing) lava.advancing = true;
  } catch {
    // Nothing assigned yet: the state is as before the update.
  }
}

/** Fire owns its environmental authority; combat policy cannot prohibit escape. */
export function attachFireReflex(bot: Bot, driver: ReflexDriver, world: WorldView): AsyncDisposable {
  const lava: LavaWatch = { advancing: false, lastChangeAge: null };
  const escapeAvailable = escapeAvailability(bot, world);
  const blockUpdate = (before: ReturnType<Bot["blockAt"]>, after: ReturnType<Bot["blockAt"]>) =>
    observeLavaUpdate(bot, lava, before, after);
  bot.on("blockUpdate", blockUpdate);
  const registration = driver.register({
    name: "fire_reflex",
    // Static lava never changes the cells the answer reads, while the body burns: try the escape again.
    retryAfterFailureMs: LETHAL_REFLEX_RETRY_MS,
    sense: () => {
      lava.advancing &&= advancingLavaAt(bot);
      const inLava = isInLava(bot);
      const inFire = isInFire(bot);
      const burning = isBurning(bot);
      if (!lava.advancing && !inLava && !inFire && !burning) return null;
      const reason: FireEscapeReason = lava.advancing ? "advancing_lava" : "contact";
      const facts: FireFacts = {
        reason,
        advancing: lava.advancing,
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
      // On dry ground the interrupted action would re-plan at once, while released lava is still spreading.
      const { escape, settle } = await escapeThenSettle(bot, world, signal, reason, () => lava.lastChangeAge);
      const kind = settle ? lavaWaitOutcomeKind(settle) : reflexOutcomeKind(escape);
      return {
        kind,
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
        : { kind: "return", reason: stoppedActionReason(outcome.kind) },
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
