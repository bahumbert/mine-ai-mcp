/**
 * The bot's burning as the server counts it (contract checks `projectile-hit-bot` and `fire-block-burn`, Mine Labs 1.21.4): a burn
 * has ticks left, the flags' bit 0 stays up until they run out, and a hurt of type `on_fire` costs 1 each time the ticks left are a
 * multiple of 20 (so the last one comes 20 ticks before the flag goes out). A new contact raises the ticks left and never lowers
 * them (a fire block after lava leaves lava's end, measured 303 against fire's 260 ticks from the last fire block). Water or a
 * death puts the burn out. The contacts: `fire-block-burn` measured 300 ticks after the last lava tick (301-303 to the flag's
 * clear), 164-176 after the last tick in a fire or soul fire block, and 100 after a small fireball's hit (`projectile-hit-bot`).
 * A fire block lights only after a stay (`fake-bot-fire.ts`); this module counts what is lit.
 */
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";

/** A hurt of `on_fire` costs this much, the ticks left being a multiple of this many. */
const BURN_DAMAGE = 1;
const BURN_HURT_EVERY_TICKS = 20;
/** The bit of the entity flags (`shared_flags`) that says an entity is on fire. */
const FIRE_FLAG = 1;

/** What the burn needs of the fights: the bot's deaths and a hurt that tells the client. */
export interface BurnParts {
  readonly server: Pick<FakeServer, "onTick">;
  readonly deaths: () => number;
  readonly hurtTheBot: (amount: number, source: Entity | null, type: string, push: Vec3 | null) => unknown;
}

/** The burn of the bot: the contacts that light it and what puts it out. */
export interface FakeBurn {
  /** A contact that burns for `ticks` more server ticks from now: the burn lasts to the later of that and what is left. */
  igniteFor(ticks: number): void;
  /** Water on the body: the flag goes out and no more is owed. */
  extinguish(): void;
}

export function attachFakeBurn(bot: FakeBot, parts: BurnParts): FakeBurn {
  let ticksLeft = 0;
  let lifeStarted = 0;
  let litThisTick = false;
  const setFlag = (burning: boolean) => {
    const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf("shared_flags") ?? -1;
    if (index < 0) return;
    const flags = Number(bot.entity.metadata[index] ?? 0);
    const next = burning ? flags | FIRE_FLAG : flags & ~FIRE_FLAG;
    if (next === flags) return;
    Reflect.set(bot.entity.metadata, index, next);
    bot.emit("entityUpdate", bot.entity);
  };
  const putOut = () => {
    ticksLeft = 0;
    setFlag(false);
  };
  parts.server.onTick(() => {
    if (ticksLeft === 0) return;
    // The tick that lit it (or lit it again) has run: the count goes down from the next one, so a burn of N ticks goes out N ticks after the contact.
    if (litThisTick) {
      litThisTick = false;
      return;
    }
    // Fire stays with the life it was lit in: a death puts it out.
    if (parts.deaths() !== lifeStarted) return putOut();
    ticksLeft -= 1;
    if (ticksLeft === 0) setFlag(false);
    else if (ticksLeft % BURN_HURT_EVERY_TICKS === 0) parts.hurtTheBot(BURN_DAMAGE, null, "on_fire", null);
  });
  return {
    igniteFor(ticks) {
      if (ticksLeft === 0) lifeStarted = parts.deaths();
      // Only a contact that raises the burn restarts the count: one that owes less than what is left changes nothing (lava, then a fire block).
      if (ticks > ticksLeft) {
        ticksLeft = ticks;
        litThisTick = true;
      }
      setFlag(true);
    },
    extinguish: putOut,
  };
}
