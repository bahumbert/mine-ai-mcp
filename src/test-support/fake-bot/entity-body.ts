/** A body of one entity made on a harness of its own, for a test that announces it by hand. */
import type { Bot } from "mineflayer";
import { type FakeEntitySpec, createFakeBot } from "./fake-bot.js";

/** A new body the server could announce under `id`, made as a body of its own and on no bot: the same kind as an earlier one is a different object, and a drop made so is not picked up by a fake's own answer (a pickup the test announces by hand, `playerCollect`). */
export function entityBodyOf(id: number, spec: FakeEntitySpec): Bot["entity"] {
  return createFakeBot({ entities: { [id]: spec } }).bot.entities[id]!;
}
