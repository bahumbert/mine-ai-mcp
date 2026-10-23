/** Stand-in for what the scenario daemon reads from a fresh 1.21.4 server with `gamerule <rule>`: the rules the physical scenarios touch. */
import type { GameruleDefaults } from "./settings.ts";

export const FRESH_SERVER_GAMERULES: GameruleDefaults = {
  doDaylightCycle: "true",
  doFireTick: "true",
  doMobSpawning: "true",
  doWeatherCycle: "true",
  keepInventory: "false",
  naturalRegeneration: "true",
  randomTickSpeed: "3",
  sendCommandFeedback: "true",
  commandModificationBlockLimit: "32768",
  commandBlockOutput: "true",
};
