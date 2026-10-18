/**
 * The two pockets run 15 left bots pinned in, cut from the frozen scene (`~/.mine-ai-backups/pinned-run15-2026-10-17/world`,
 * read with `.agent/scripts/frozen-scene/blocks.py`). Both bots carried the style override `dig_straight_down: false`.
 * Dirk stood at -549 56 -50 and Sana at -455 57 100; each fixture is the 5x5 columns around the bot, stone outside and
 * water over the top as in the scene. `dirkItems` and `sanaItems` are what they carried.
 */
import type { Bot } from "mineflayer";
import type { FakeStack } from "./bot.js";
import { layeredWorld } from "./layered-world.js";

const LEGEND = {
  A: "air",
  S: "stone",
  G: "gravel",
  C: "cobblestone",
  L: "oak_log",
  W: "water",
  P: "oak_planks",
  R: "granite",
  T: "crafting_table",
  B: "birch_planks",
  D: "dirt",
  N: "andesite",
  I: "oak_stairs",
  /** Falling or flowing water: every water cell of Sana's pocket below the surface sheet was one. */
  F: "water[level=8]",
} as const;

const outside = (waterFrom: number) => (y: number) => (y >= waterFrom ? "water" : "stone");

/** Dirk: gravel west and north, a crafting table south, stone and water east; the block below is cobblestone over stone, an air cave east at y 55. */
export const DIRK_START = { x: -549, y: 56, z: -50 } as const;
/** The air cell of the cave east and below Dirk's cell. */
export const DIRK_CAVE = { x: -548, y: 55, z: -50 } as const;
export function dirkPocket(bot: Pick<Bot, "registry">) {
  return layeredWorld(bot, {
    origin: { x: -551, z: -52 },
    legend: LEGEND,
    outside: outside(60),
    margin: 4,
    yRange: { min: 52, max: 62 },
    layers: {
      59: ["WWWWW", "CLWCW", "ACLAG", "ALWWW", "APWAA"],
      58: ["WWWWW", "WWLWW", "SGAGL", "SGLGW", "SARPW"],
      57: ["WWWWW", "GWGWW", "GGASW", "SSRLG", "SAASW"],
      56: ["WWWWW", "GGGLW", "GGAAS", "SSTSS", "SSWSS"],
      55: ["WWWWW", "GSGBW", "SSCAS", "SAAAS", "SSWSS"],
      54: ["SSWWW", "SSSWW", "SSSRR", "SAARR", "SAWAS"],
    },
  });
}

/** Sana: falling water west and north, andesite east, oak stairs over the cell south; andesite below, an air cave south at y 55-56. */
export const SANA_START = { x: -455, y: 57, z: 100 } as const;
/** The cave floor south of the cell below Sana (the cave is two high, y 55-56). */
export const SANA_CAVE = { x: -455, y: 55, z: 101 } as const;
export function sanaPocket(bot: Pick<Bot, "registry">) {
  return layeredWorld(bot, {
    origin: { x: -457, z: 98 },
    legend: LEGEND,
    outside: outside(61),
    margin: 4,
    yRange: { min: 52, max: 62 },
    layers: {
      60: ["AALWW", "ADPWW", "AALWW", "DDWWW", "DDWWW"],
      59: ["PPIWW", "FFIWW", "AFLWN", "ADWWN", "DDWGS"],
      58: ["FFFIW", "FPFPN", "FFANN", "DFINN", "DDSSS"],
      57: ["FFPIN", "DFFNN", "FFANN", "DDANN", "DSSSS"],
      56: ["FFLNN", "FFNNN", "DDNNN", "DAANN", "SSASG"],
      55: ["FNNNN", "SNNNN", "DDSNN", "SAAAN", "SAAAG"],
    },
  });
}

/** What each bot carried when the scene was frozen: a search counts the cobblestone as scaffold, so Dirk can pillar up one cell. */
export const dirkItems = (): FakeStack[] => [
  { name: "stone_pickaxe", count: 1 }, { name: "wooden_pickaxe", count: 1 }, { name: "cobblestone", count: 10 }, { name: "oak_planks", count: 3 },
];
export const sanaItems = (): FakeStack[] => [{ name: "stone_pickaxe", count: 1 }, { name: "dirt", count: 9 }, { name: "cobblestone", count: 13 }];
