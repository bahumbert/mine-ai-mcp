/** Wait for server metadata confirming release of arranged mobs. */
import { monotonicNow } from "../../src/utils/monotonic-clock.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

type Target = "primary" | "alternative";

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
