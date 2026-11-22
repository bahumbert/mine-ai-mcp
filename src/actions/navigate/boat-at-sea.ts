// One boat-centred shore observation for seated sensing and responses.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { holdsWater, isDeepOpenWater } from "../../navigation/world/deep-water.js";
import { launchSpot, waterSurface } from "./boat-crossing.js";

/** Deep water under the boat, with no observed bank within the policy's distance from that boat. */
export function atSeaFrom(bot: Bot, boatCell: Vec3, range: number): boolean {
  const surface = waterSurface(bot, Math.floor(boatCell.x), Math.floor(boatCell.z), Math.floor(boatCell.y) + 1);
  if (surface === null) return false;
  const water = (x: number, y: number, z: number) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block !== null && holdsWater(block.name, block.getProperties());
  };
  if (!isDeepOpenWater(water, Math.floor(boatCell.x), surface, Math.floor(boatCell.z))) return false;
  return launchSpot(bot, new Vec3(Math.floor(boatCell.x), surface, Math.floor(boatCell.z)), range,
    (spot) => spot.distanceTo(boatCell) <= range) === null;
}
