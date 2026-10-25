/**
 * The bot's swing counter on the fake server: the server ticks since her last attack, which every hit the server
 * handles (a creature, a boat, a fireball) reads for its strength and starts over (`Player.attack`;
 * `Player.tick` starts it over too when a different item type comes into the main hand). A bot that has stood about
 * has a full swing (the ticker counts from the login).
 */
import { onServerTick } from "./fake-bot-server-ticks.js";
import type { FakeInventory } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";

const STANDING_SWING_TICKS = 1_000;

export interface Swing {
  /** The server ticks since the last attack (or the last change of the main hand's item type). */
  ticksSince(): number;
  /** An attack the server handled: the swing starts over. */
  startOver(): void;
}

/** Count the swing on `server`'s ticks, starting it over when the held item's type changes. */
export function attachFakeSwing(parts: { server: FakeServer; inventory: FakeInventory }): Swing {
  let ticksSinceSwing = STANDING_SWING_TICKS;
  let heldType = parts.inventory.heldItem?.type;
  onServerTick(parts.server, () => void (ticksSinceSwing += 1));
  parts.inventory.onHeldItemChanged((held) => {
    if (held?.type !== heldType) ticksSinceSwing = 0;
    heldType = held?.type;
  });
  return { ticksSince: () => ticksSinceSwing, startOver: () => void (ticksSinceSwing = 0) };
}
