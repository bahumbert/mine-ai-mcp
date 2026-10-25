/**
 * The fake bot's `attack` and what a hit does to a boat (contract check `boat-broken-by-attack`, Mine Labs 1.21.4,
 * 2026-10-23): 10 damage a hit by hand, 1 lost a server tick, broken once it holds more than 40 (8 hits 250 ms apart,
 * 17 at 400 ms). A hit weighs 10 x the hand's swing damage at the strength the bot's one swing counter has (`fake-bot-swing.ts`:
 * a creature hit or a deflected fireball started it over too), `0.2 + 0.8 x strength^2` (`Player.attack`, read in the source;
 * the contract check judges the real server by it). It breaks at the hit: the boat is removed, its item lies where it
 * stood for the 10 ticks measured, and every rider is freed on the server and told nothing (no position, no passenger
 * list: her client keeps its `vehicle`). An item that is no weapon or tool hits as the hand does; a hit with a weapon or
 * tool throws (the scaling of its damage is unmeasured). Vanilla's rules, not in the fake: a sprinting hit past 0.9 strength ends the sprint
 * (`Player.attack`, source only; a creature hit does it in `fake-bot-combat.ts`), a creative bot's boat drops
 * nothing, a chest boat drops its chest, the hurt wobble. The reach of a hit is the mob hit's (`attack-out-of-reach`); unmeasured at the edge for a boat.
 */
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { HAND, hitsAsHand, swingDamage } from "./fake-bot-combat-rules.js";
import type { ServerEntities } from "./fake-bot-entities.js";
import { BOAT_NAME, inEntityReach } from "./fake-bot-entity-reach.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import type { Swing } from "./fake-bot-swing.js";
import type { FakeBot } from "./fake-bot.js";
import type { FakeInventory } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";

/** A boat takes 10 times the attack damage of the hit (1 by hand: 10 a full swing, measured). */
const BOAT_DAMAGE_PER_ATTACK_DAMAGE = 10;
const BREAKS_ABOVE = 40;
/** A broken boat's item cannot be picked up for this many ticks (477 to 489 ms measured). */
const DROP_PICKUP_DELAY_TICKS = 10;

type DamageParts = { server: FakeServer; entities: ServerEntities; inventory: FakeInventory; swing: Swing };

/** What a hit on a boat adds to its damage now; it starts the swing over. Throws for a weapon or tool in hand. */
function boatDamageOfHit({ inventory, swing }: DamageParts): number {
  const held = inventory.heldItem?.name;
  if (!hitsAsHand(held)) throw new Error(`boat hit with ${held}: not modelled, unmeasured (a boat takes 10 x a weapon's attack damage in vanilla; measure it with a contract check first)`);
  const damage = BOAT_DAMAGE_PER_ATTACK_DAMAGE * swingDamage(HAND, swing.ticksSince());
  swing.startOver();
  return damage;
}

/** The boat breaks: it leaves the client, drops its item where it stood and frees all its riders, who hear nothing. */
function breakBoat(parts: DamageParts, boat: Entity): void {
  const stood = (parts.server.serverPositionOf(boat.id) ?? boat.position).clone();
  parts.server.freeRider(boat.id);
  parts.entities.remove(boat.id);
  parts.entities.spawn({ name: "item", position: stood, item: { name: boat.name!, count: 1 }, pickupDelayTicks: DROP_PICKUP_DELAY_TICKS });
}

/** Give `bot` `attack` and the server's answer to a hit on a boat. */
export function attachFakeBoatDamage(bot: FakeBot, parts: DamageParts): void {
  const damage = new Map<number, number>();
  onServerTick(parts.server, () => {
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
      const total = (damage.get(boat.id) ?? 0) + boatDamageOfHit(parts);
      if (total <= BREAKS_ABOVE) damage.set(boat.id, total);
      else {
        damage.delete(boat.id);
        breakBoat(parts, boat);
      }
    });
  });
}
