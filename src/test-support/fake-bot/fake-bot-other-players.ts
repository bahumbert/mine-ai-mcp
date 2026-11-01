/**
 * Other players on the fake server. The server lists a player to the bot (the tab list) the moment they join, but sends their
 * entity, and so a position, only while it tracks them to the bot: contract check `far-player-position` (Mine Labs 1.21.4,
 * `view-distance` 8, 2026-11-01) measured a survival player tracked at 40, 85, 121 and 128 blocks and not at 135 or farther, and a
 * spectator not at all, at every distance (the bot being in survival). Mineflayer's side is `entities.js:215-218` (the entity
 * filed under the player) and `entities.js:309-320` (cleared when the entity is destroyed). Limits: the range is checked when the
 * player joins, moves or changes mode, not when the bot moves (the server checks every tick); it is the 3D distance, measured only
 * along x at the bot's height (whether vanilla measures it horizontally is unmeasured).
 */
import type { Vec3 } from "vec3";
import type { FakeBot } from "./fake-bot.js";
import type { ServerEntities } from "./fake-bot-entities.js";
import type { FakeServer } from "./fake-server.js";

/** The farthest a survival player is tracked to a bot (blocks): the view distance of 8 chunks. */
export const PLAYER_TRACKING_BLOCKS = 128;

export type OtherPlayerGameMode = "survival" | "spectator";
/** The game mode number the server's player_info update carries, which Mineflayer files on the tab list entry (`bot.players[name].gamemode`). */
const GAMEMODE_NUMBER: Readonly<Record<OtherPlayerGameMode, number>> = { survival: 0, spectator: 3 };

/** A player the server controls: where they stand and their game mode. */
export interface FakeOtherPlayer {
  /** The server moves the player; the bot hears of it (a spawn, or the entity destroyed) on the next tick. */
  moveTo(position: Vec3): void;
  setGameMode(mode: OtherPlayerGameMode): void;
  /** The player logs out: the tab list entry and the entity go. */
  leave(): void;
}

export interface FakeOtherPlayers {
  /** A player named `name` joins at `position` in survival: listed to the bot at once, tracked to it by the rule above. */
  join(name: string, position: Vec3): FakeOtherPlayer;
}

interface OtherPlayerParts {
  readonly server: FakeServer;
  readonly entities: ServerEntities;
}

/** Give the harness the controls of other players. */
export function attachFakeOtherPlayers(bot: FakeBot, parts: OtherPlayerParts): FakeOtherPlayers {
  const { server, entities } = parts;
  return {
    join(name, startPosition) {
      let position = startPosition;
      let mode: OtherPlayerGameMode = "survival";
      let tracked: number | null = null;
      const listed = { username: name, uuid: "", ping: 0, gamemode: 0, displayName: undefined, entity: null as unknown };
      Object.assign(bot.players, { [name]: listed });
      const untrack = () => {
        if (tracked === null) return;
        entities.remove(tracked);
        listed.entity = null;
        tracked = null;
      };
      /** Whether the server tracks the player to the bot now, and the entity follows: spawned, moved or destroyed. */
      const follow = () => {
        const shouldTrack = mode === "survival" && position.distanceTo(bot.entity.position) <= PLAYER_TRACKING_BLOCKS;
        if (!shouldTrack) return untrack();
        if (tracked === null) {
          const entity = entities.spawn({ name: "player", position, username: name });
          tracked = entity.id;
          listed.entity = entity;
        } else {
          const entity = bot.entities[tracked]!;
          entity.position.set(position.x, position.y, position.z);
          bot.emit("entityMoved", entity);
        }
      };
      const change = (apply: () => void) => server.answer(() => (apply(), follow()));
      follow();
      return {
        moveTo: (to) => change(() => void (position = to)),
        setGameMode: (to) => change(() => void ((mode = to), (listed.gamemode = GAMEMODE_NUMBER[to]))),
        leave() {
          server.answer(() => {
            untrack();
            delete bot.players[name];
          });
        },
      };
    },
  };
}
