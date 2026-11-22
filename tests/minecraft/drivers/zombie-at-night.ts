import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { Entity } from "prismarine-entity";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import type { ScenarioContext } from "../scenario.ts";
import { observeDeaths } from "./deaths.ts";

const paramsSchema = z.strictObject({ withinSeconds: z.number().positive() });
const POLL_MS = 250;
/** `PersistenceRequired`: the zombie does not despawn mid-trial; it is told nothing about the actor. */
const SUMMON_ZOMBIE = "/execute at @s run summon minecraft:zombie ~3 ~ ~ {PersistenceRequired:1b}";

/** Who was hurt and by whom, as entity ids: the pairing is judged once the zombie's id is known. */
interface Hurt {
  readonly entityId: number;
  readonly sourceId: number | null;
}

/**
 * A zombie three blocks from the actor at night; the bot's reflexes answer as they choose. Passes when, within the bound,
 * the zombie and the actor hurt each other (either way) and then the zombie is gone or a death was read.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { withinSeconds } = paramsSchema.parse(context.scenario.params);
  const { bot } = context;
  const seen = observeDeaths(bot);
  const hurts: Hurt[] = [];
  const onHurt = (entity: Entity, source?: Entity | null): void => {
    hurts.push({ entityId: entity.id, sourceId: source?.id ?? null });
  };
  bot.on("entityHurt", onHurt);
  try {
    await context.waitForTicks(10);
    const sentAt = monotonicNow();
    bot.chat(SUMMON_ZOMBIE);
    const zombie = await zombieSeen(context, sentAt, withinSeconds);
    if (!zombie) return { status: "failed", detail: `no zombie appeared within ${withinSeconds} s of the summon: check that the actor is op in the YAML and the summon command was not refused` };
    const verdict = () => {
      const exchanged = hurts.some(({ entityId, sourceId }) => (entityId === zombie.id && sourceId === bot.entity.id) || (entityId === bot.entity.id && sourceId === zombie.id));
      const zombieGone = bot.entities[zombie.id] === undefined;
      return { exchanged, ended: zombieGone || seen.deaths.length > 0, zombieGone };
    };
    while (monotonicNow() - sentAt < withinSeconds * 1000) {
      const now = verdict();
      if (now.exchanged && now.ended) break;
      await sleep(POLL_MS);
    }
    const end = verdict();
    const detail = `exchanged blows ${end.exchanged}, zombie gone ${end.zombieGone}, deaths ${seen.deaths.length}, respawns ${seen.respawns.length}, hurts ${JSON.stringify(hurts)}`;
    return end.exchanged && end.ended ? { status: "succeeded", detail } : { status: "failed", detail: `not settled within ${withinSeconds} s: ${detail}` };
  } finally {
    bot.off("entityHurt", onHurt);
    seen.dispose();
  }
}

/** The summoned zombie as the client sees it, polled in real time up to the bound. */
async function zombieSeen(context: ScenarioContext, sentAt: number, withinSeconds: number): Promise<Entity | undefined> {
  while (monotonicNow() - sentAt < withinSeconds * 1000) {
    const zombie = Object.values(context.bot.entities).find((entity) => entity.name === "zombie");
    if (zombie) return zombie;
    await sleep(POLL_MS);
  }
  return undefined;
}
