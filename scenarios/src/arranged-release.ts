/** Wait for server metadata confirming release of arranged mobs. */
import type { Entity } from "prismarine-entity";
import { monotonicNow } from "../../src/utils/monotonic-clock.ts";
import { waitForServerPaced } from "../../src/world/server-paced.ts";
import { SERVER_ANSWER_TICKS } from "../../src/world/world-age.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

type Target = "primary" | "alternative";

/** Keep wall time as diagnostics alongside the server's packet age, never as progress. */
function waitDetails(context: MineAiScenarioContext, startedMs: number, startAge: number | null, end: string) {
  const age = context.bot.time?.age ?? null;
  return { end, elapsedMs: monotonicNow() - startedMs, elapsedTicks: startAge === null || age === null ? null : age - startAge };
}

/** Remove tagged entities and wait for both server disappearance answers. */
export async function removeArrangedEntities(context: MineAiScenarioContext, targets: readonly { tag: string; id: number }[]): Promise<void> {
  const { bot, signal } = context;
  signal.throwIfAborted();
  const pending = new Set(targets.map((target) => target.id));
  const positions = new Map<number, { x: number; y: number; z: number }>();
  for (const { tag, id } of targets) {
    const entity = bot.entities[id];
    if (entity) positions.set(id, { x: entity.position.x, y: entity.position.y, z: entity.position.z });
    else { pending.delete(id); context.log(`arranged ${tag} id ${id} already gone before removal`); }
  }
  const answers: string[] = [];
  const startedMs = monotonicNow();
  const startAge = bot.time?.age ?? null;
  const gone = (entity: Entity) => { pending.delete(entity.id); };
  const moved = (entity: Entity) => {
    if (pending.has(entity.id)) positions.set(entity.id, { x: entity.position.x, y: entity.position.y, z: entity.position.z });
  };
  const message = (answer: string) => { answers.push(answer); };
  bot.on("entityGone", gone);
  bot.on("entityMoved", moved);
  bot.on("messagestr", message);
  try {
    for (const { tag } of targets) bot.chat(`/kill @e[tag=${tag}]`);
    const end = await waitForServerPaced(bot, 100, { until: () => pending.size === 0, signal });
    if (end !== "until") {
      const detail = {
        pending: targets.filter(({ id }) => pending.has(id)).map(({ tag, id }) => ({ tag, id, present: Boolean(bot.entities[id]), position: positions.get(id) ?? null })),
        commands: targets.map(({ tag }) => `/kill @e[tag=${tag}]`), answers,
        ...waitDetails(context, startedMs, startAge, end),
      };
      throw new Error(`arranged Endermen not removed: ${JSON.stringify(detail)}`);
    }
  } finally {
    bot.off("entityGone", gone);
    bot.off("entityMoved", moved);
    bot.off("messagestr", message);
  }
}

/** Check target transitions in order, ignoring unrelated changes and their reasons. */
export function changesObserved(changes: readonly { fromTargetId: number | null; toTargetId: number | null }[], expected: readonly (readonly [Target, Target])[], ids: Record<Target, number>): boolean {
  let index = 0;
  for (const change of changes) {
    const pair = expected[index];
    if (pair && change.fromTargetId === ids[pair[0]] && change.toTargetId === ids[pair[1]]) index++;
  }
  return index === expected.length;
}

/** Bind a tagged mob to the server's NoAI metadata answer. */
export async function releaseByTag(context: MineAiScenarioContext, tag: string, species: string): Promise<number> {
  const { bot, signal } = context;
  signal.throwIfAborted();
  const startedMs = monotonicNow();
  const startAge = bot.time?.age ?? null;
  const candidates = new Set(Object.values(bot.entities).filter((entity) => entity.isValid && entity.name === species).map((entity) => entity.id));
  const answers = new Set<number>();
  const metadata = (packet: { entityId: number; metadata: { key: number; value: unknown }[] }) => {
    if (candidates.has(packet.entityId) && packet.metadata.some((entry) => entry.key === 15 && typeof entry.value === "number" && (entry.value & 1) === 0)) answers.add(packet.entityId);
  };
  bot._client.on("entity_metadata", metadata);
  try {
    bot.chat(`/data merge entity @e[tag=${tag},limit=1] {NoAI:0b}`);
    const end = await waitForServerPaced(bot, SERVER_ANSWER_TICKS, { until: () => answers.size > 1, signal });
    if (answers.size > 1) throw new Error("ambiguous release");
    const id = answers.values().next().value;
    if (end !== "ticks" || id === undefined) throw new Error(`release not answered (${end}): ${JSON.stringify(waitDetails(context, startedMs, startAge, end))}`);
    return id;
  } finally {
    bot._client.off("entity_metadata", metadata);
  }
}

/** Send the release command and settle when every arranged mob answers or the bound expires. */
export async function waitForReleaseAnswers(context: MineAiScenarioContext, pending: Set<number>, command: string): Promise<void> {
  const { bot, signal } = context;
  signal.throwIfAborted();
  const sentAt = monotonicNow();
  const startAge = bot.time?.age ?? null;
  const metadata = (packet: { entityId: number; metadata: { key: number; value: unknown }[] }) => {
    const now = monotonicNow();
    if (packet.metadata.some((entry) => entry.key === 15 && typeof entry.value === "number" && (entry.value & 1) === 0) && pending.delete(packet.entityId)) {
      context.log(`release acknowledged ${JSON.stringify({ entityId: packet.entityId, ms: now - sentAt })}`);
    }
  };
  const message = (answer: string) => context.log(`release answer ${answer}`);
  bot._client.on("entity_metadata", metadata);
  bot.on("messagestr", message);
  try {
    context.log(`release sent ${JSON.stringify({ pending: [...pending] })}`);
    bot.chat(command);
    const end = await waitForServerPaced(bot, SERVER_ANSWER_TICKS, { until: () => pending.size === 0, signal });
    if (end !== "until") {
      const detail = { pending: [...pending], ms: monotonicNow() - sentAt, ...waitDetails(context, sentAt, startAge, end) };
      context.log(`release timeout ${JSON.stringify(detail)}`);
      throw new Error(`release not answered (${end}): ${JSON.stringify(detail)}`);
    }
  } finally {
    bot._client.off("entity_metadata", metadata);
    bot.off("messagestr", message);
  }
}
