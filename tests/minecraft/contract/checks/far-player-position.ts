/**
 * Whether the bot has a position for a second player who stands far off: `bot.players[name].entity` exists only while the server
 * tracks that player to the bot (a spectator is sent to spectators only, and a survival player only within the tracking range),
 * so a player beyond it is a name with no position. The brain's look lists such a player as "far away" with no distance.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { serverQuiet } from "../server-answer.ts";
import type { OtherPlayerMode } from "../subject.ts";

const WATCHED = "Watched";
const DISTANCES = [40, 85, 121, 128, 135, 150, 160, 170] as const;
const MODES: readonly OtherPlayerMode[] = ["survival", "spectator"];
/** Whether the bot has the watched player's position, by mode and distance in blocks (x), as measured. */
const POSITION_KNOWN: Readonly<Record<OtherPlayerMode, Readonly<Record<(typeof DISTANCES)[number], boolean>>>> = {
  survival: { 40: true, 85: true, 121: true, 128: true, 135: false, 150: false, 160: false, 170: false },
  spectator: { 40: false, 85: false, 121: false, 128: false, 135: false, 150: false, 160: false, 170: false },
};

export const farPlayerPosition: ContractCheck = {
  name: "far-player-position",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5] },
  withoutRuntime: true,
  exclusive: "a second player joins the server and the template's tick command puts every other player in spectator",
  async run(subject) {
    const { bot } = subject;
    const player = await subject.joinPlayer(WATCHED);
    try {
      const known: Record<string, Record<number, boolean>> = {};
      for (const mode of MODES) {
        await player.setGameMode(mode);
        known[mode] = {};
        for (const distance of DISTANCES) {
          await player.moveTo(subject.world([0.5 + distance, -60, 0.5]));
          await serverQuiet(subject, `${mode} player ${distance} blocks off`);
          assert.ok(bot.players[WATCHED], `${WATCHED} is no longer listed (kicked?) with the ${mode} player ${distance} blocks off`);
          known[mode][distance] =bot.players[WATCHED]?.entity?.position !== undefined;
        }
      }
      assert.deepEqual(known, POSITION_KNOWN);
    } finally {
      await player.leave();
    }
  },
};
