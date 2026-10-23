/**
 * The fake bot's `attack` and what a hit does to a boat (contract check `boat-broken-by-attack`, Mine Labs 1.21.4,
 * 2026-10-23): 10 damage a hit, 1 lost a server tick, broken once it holds more than 40 (8 hits 250 ms apart, 17 at 400
 * ms). It breaks at the hit: the boat is removed, its item lies where it stood for the 10 ticks measured, and every
 * rider is freed on the server and told nothing (no position, no passenger list: her client keeps its `vehicle`).
 * Vanilla's rules, not in the fake (an iron sword still takes 8 hits, as a hand): a weapon hits harder, a hit sooner than the 5 ticks of attack recovery
 * weighs less, a creative bot's boat drops nothing, a chest boat drops its chest, the hurt wobble. The reach of a hit is the mount's (unmeasured).
 */
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { ServerEntities } from "./fake-bot-entities.js";
import { BOAT_NAME, inEntityReach } from "./fake-bot-entity-reach.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import type { FakeBot } from "./fake-bot.js";
import type { FakeClock } from "./fake-clock.js";
import type { FakeServer } from "./fake-server.js";

const HIT_DAMAGE = 10;
const BREAKS_ABOVE = 40;
/** A broken boat's item cannot be picked up for this many ticks (477 to 489 ms measured). */
const DROP_PICKUP_DELAY_TICKS = 10;

type DamageParts = { clock: FakeClock; server: FakeServer; entities: ServerEntities };

/** The boat breaks: it leaves the client, drops its item where it stood and frees all its riders, who hear nothing. */
function breakBoat(bot: FakeBot, parts: DamageParts, boat: Entity): void {
  const stood = (parts.server.serverPositionOf(boat.id) ?? boat.position).clone();
  parts.server.freeRider(boat.id);
  parts.entities.remove(boat.id);
  parts.entities.spawn({ name: "item", position: stood, item: { name: boat.name!, count: 1 }, pickupDelayTicks: DROP_PICKUP_DELAY_TICKS });
}

/** Give `bot` `attack` and the server's answer to a hit on a boat. */
export function attachFakeBoatDamage(bot: FakeBot, parts: DamageParts): void {
  const damage = new Map<number, number>();
  onServerTick(parts.clock, parts.server, () => {
    for (const [id, held] of damage) {
      if (held <= 1) damage.delete(id);
      else damage.set(id, held - 1);
    }
  });
  // `entities.js:860-873` for a version with no attack packet: `use_entity` with the left click, then the arm swings.
  bot.attack = (target) => {
    bot._client.write("use_entity", { target: target.id, mouse: 1, sneaking: bot.controlState.sneak, location: new Vec3(0, 0, 0) });
    bot.swingArm(undefined);
  };
  parts.server.onPacket("use_entity", (data) => {
    const { target, mouse } = data as { target: number; mouse: number };
    if (mouse !== 1) return;
    parts.server.answer(() => {
      const boat = bot.entities[target];
      if (boat === undefined || !BOAT_NAME.test(boat.name ?? "") || !inEntityReach(bot, parts.server, boat)) return;
      const total = (damage.get(boat.id) ?? 0) + HIT_DAMAGE;
      if (total <= BREAKS_ABOVE) damage.set(boat.id, total);
      else {
        damage.delete(boat.id);
        breakBoat(bot, parts, boat);
      }
    });
  });
}
