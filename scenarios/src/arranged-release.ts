/** Wait for server metadata confirming release of arranged mobs. */
import type { Entity } from "prismarine-entity";
import { monotonicNow } from "../../src/utils/monotonic-clock.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

type Target = "primary" | "alternative";

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
  const deadline = monotonicNow() + 5_000;
  await new Promise<void>((resolve, reject) => {
    let ticks = 0;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bot.off("entityGone", gone);
      bot.off("physicsTick", tick);
      bot.off("messagestr", message);
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve();
    };
    const fail = () => finish(new Error(`arranged Endermen not removed: ${JSON.stringify({ pending: targets.filter(({ id }) => pending.has(id)).map(({ tag, id }) => ({ tag, id, present: Boolean(bot.entities[id]), position: positions.get(id) ?? null })), commands: targets.map(({ tag }) => `/kill @e[tag=${tag}]`), answers })}`));
    const gone = (entity: Entity) => {
      if (monotonicNow() >= deadline) return fail();
      pending.delete(entity.id);
      if (pending.size === 0) finish();
    };
    const tick = () => {
      for (const id of pending) {
        const entity = bot.entities[id];
        if (entity) positions.set(id, { x: entity.position.x, y: entity.position.y, z: entity.position.z });
      }
      if (++ticks >= 100 || monotonicNow() >= deadline) fail();
    };
    const message = (answer: string) => { answers.push(answer); };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(fail, 5_000);
    bot.on("entityGone", gone);
    bot.on("physicsTick", tick);
    bot.on("messagestr", message);
    signal.addEventListener("abort", abort, { once: true });
    for (const { tag } of targets) bot.chat(`/kill @e[tag=${tag}]`);
    if (pending.size === 0) finish();
  });
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
  const deadline = monotonicNow() + 1_100;
  const candidates = new Set(Object.values(bot.entities).filter((entity) => entity.isValid && entity.name === species).map((entity) => entity.id));
  const answers = new Set<number>();
  return await new Promise<number>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); bot._client.off("entity_metadata", metadata); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const metadata = (packet: { entityId: number; metadata: { key: number; value: unknown }[] }) => {
      if (monotonicNow() > deadline) { cleanup(); reject(new Error("release not answered")); return; }
      if (candidates.has(packet.entityId) && packet.metadata.some((entry) => entry.key === 15 && typeof entry.value === "number" && (entry.value & 1) === 0)) answers.add(packet.entityId);
      if (answers.size > 1) { cleanup(); reject(new Error("ambiguous release")); }
    };
    const timer = setTimeout(() => {
      cleanup();
      const id = answers.values().next().value;
      if (id === undefined) reject(new Error("release not answered")); else resolve(id);
    }, 1_100);
    bot._client.on("entity_metadata", metadata);
    signal.addEventListener("abort", abort, { once: true });
    bot.chat(`/data merge entity @e[tag=${tag},limit=1] {NoAI:0b}`);
  });
}

/** Send the release command and settle when every arranged mob answers or the bound expires. */
export async function waitForReleaseAnswers(context: MineAiScenarioContext, pending: Set<number>, command: string): Promise<void> {
  const { bot, signal } = context;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const deadline = monotonicNow() + 1_100;
  let sentAt = 0;
  const cleanup = () => {
    clearTimeout(timer);
    bot._client.off("entity_metadata", metadata);
    bot.off("messagestr", message);
    signal.removeEventListener("abort", abort);
  };
  const finish = (error?: unknown) => { cleanup(); if (error) reject(error); else resolve(); };
  const metadata = (packet: { entityId: number; metadata: { key: number; value: unknown }[] }) => {
    const now = monotonicNow();
    if (packet.metadata.some((entry) => entry.key === 15 && typeof entry.value === "number" && (entry.value & 1) === 0) && pending.delete(packet.entityId)) {
      context.log(`release acknowledged ${JSON.stringify({ entityId: packet.entityId, ms: now - sentAt })}`);
    }
    if (now > deadline) return finish(new Error("release not answered"));
    if (pending.size === 0) finish();
  };
  const message = (answer: string) => context.log(`release answer ${answer}`);
  const abort = () => finish(signal.reason);
  const timer = setTimeout(() => {
    context.log(`release timeout ${JSON.stringify({ pending: [...pending], ms: monotonicNow() - sentAt })}`);
    finish(new Error("release not answered"));
  }, Math.max(0, deadline - monotonicNow()));
  bot._client.on("entity_metadata", metadata);
  bot.on("messagestr", message);
  signal.addEventListener("abort", abort, { once: true });
  sentAt = monotonicNow();
  context.log(`release sent ${JSON.stringify({ pending: [...pending] })}`);
  bot.chat(command);
  if (pending.size === 0) finish();
  return await promise;
}
