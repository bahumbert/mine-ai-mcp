/**
 * A second player on the server, for a check that measures what the bot hears of someone else: a real Mineflayer client on a real
 * server (found by the bot's own socket), moved and put in a game mode by the op bot's commands.
 */
import { once } from "node:events";
import mineflayer, { type Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { FakeHarness } from "../../../src/test-support/fake-bot/index.ts";
import type { OtherPlayer } from "./subject.ts";

/** A server answer reaches the fake client one slice after the packet that asked (`FakeServer.answer`). */
const ANSWER_SLICE_MS = 50;

/** The fake server's second player: joins two blocks from the bot, every command answered one slice later. */
export async function joinOnFake({ bot, clock, server, otherPlayers }: FakeHarness, name: string): Promise<OtherPlayer> {
  let joined: ReturnType<typeof otherPlayers.join> | undefined;
  server.answer(() => void (joined = otherPlayers.join(name, bot.entity.position.offset(2, 0, 0))));
  await clock.advance(ANSWER_SLICE_MS);
  const act = async (command: () => void) => {
    command();
    await clock.advance(ANSWER_SLICE_MS);
  };
  return {
    moveTo: (position) => act(() => joined!.moveTo(position)),
    setGameMode: (mode) => act(() => joined!.setGameMode(mode)),
    leave: () => act(() => joined!.leave()),
  };
}

/** The wall bound of the second client's login (the server may be behind by seconds while another lane arranges). */
const JOIN_WALL_MS = 30_000;

/** Join as `name` the server `bot` is on; the player stands where the server puts it until `moveTo`. */
export async function joinOnServer(bot: Bot, name: string): Promise<OtherPlayer> {
  const socket = (bot._client as unknown as { socket: { remoteAddress: string; remotePort: number } }).socket;
  const player = mineflayer.createBot({ host: socket.remoteAddress, port: socket.remotePort, username: name, version: bot.version, auth: "offline" });
  player.on("error", () => {});
  try {
    await once(player as never, "spawn", { signal: AbortSignal.timeout(JOIN_WALL_MS) });
  } catch (cause) {
    player.end();
    throw new Error(`${name} did not join within ${JOIN_WALL_MS} ms: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return {
    async moveTo(position: Vec3) {
      bot.chat(`/tp ${name} ${position.x} ${position.y} ${position.z}`);
    },
    async setGameMode(mode) {
      bot.chat(`/gamemode ${mode} ${name}`);
    },
    async leave() {
      player.end();
    },
  };
}
