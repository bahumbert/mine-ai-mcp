// What counts as progress while a combat response holds the body: the fight moved, or the shelter holds.
import type { Bot } from "mineflayer";
import { AnchorTravel } from "../../session/anchor-travel.js";
import { enclosedInPlace } from "../responses/shelter-cells.js";
import { meleeDistance } from "../weapons/melee.js";
import { nearsBy, watchBodyTicks } from "./reflex-progress.js";

/** The entity status the server sends the bot when its shield took a hit that would have hurt it. */
const SHIELD_BLOCK_STATUS = 29;

/**
 * Progress marks for a fight, evade, hide or deflect against `threatIds`, besides the base probe (the bot travelled, its
 * health changed): damage to the bot or to a threat (a swing or shot was answered by the server), a threat dead or gone,
 * a threat coming a block nearer in a fight. Other responses also count target travel, shield blocks and shelter
 * holds (protected waiting with their own timeout). A fight without a mark for the window is a standoff.
 * Returns the detach.
 */
export function observeCombatProgress(
  bot: Bot, threatIds: readonly number[], mark: (reason: string) => void, response = "evade",
): () => void {
  const fight = response === "fight";
  const threats = new Set(threatIds);
  const onHurt = (entity: { id: number }) => {
    if (entity.id === bot.entity.id || threats.has(entity.id)) mark("hurt");
  };
  const onDead = (entity: { id: number }) => {
    if (threats.has(entity.id)) mark("threat_dead");
  };
  const onGone = (entity: { id: number }) => {
    if (threats.has(entity.id)) mark("threat_gone");
  };
  const onStatus = (packet: { entityId: number; entityStatus: number }) => {
    if (!fight && packet.entityId === bot.entity.id && packet.entityStatus === SHIELD_BLOCK_STATUS) mark("shield_block");
  };
  const client = (bot as { _client?: Bot["_client"] })._client;
  bot.on("entityHurt", onHurt);
  bot.on("entityDead", onDead);
  bot.on("entityGone", onGone);
  client?.on("entity_status", onStatus);
  const stopTicks = watchBodyTicks(bot, mark, fight ? {
    target_nearer: threatsNearer(bot, threatIds),
  } : {
    target_moved: threatsMoved(bot, threatIds),
    enclosed: () => enclosedInPlace(bot),
  });
  return () => {
    stopTicks();
    bot.off("entityHurt", onHurt);
    bot.off("entityDead", onDead);
    bot.off("entityGone", onGone);
    client?.off("entity_status", onStatus);
  };
}

/** Each threat retains its own distance to beat, even while another comes nearer. */
function threatsNearer(bot: Bot, threatIds: readonly number[]): () => boolean {
  const samplers = threatIds.map(id => nearsBy(() => {
    const entity = bot.entities[id];
    return entity?.isValid ? meleeDistance(bot, entity) : null;
  }, 1));
  // Establish all anchors before either side can move after admission.
  for (const sample of samplers) sample();
  return () => samplers.map(sample => sample()).some(Boolean);
}

/** A sampler that says true when any of the threats is a block from where it was at its last mark. */
function threatsMoved(bot: Bot, threatIds: readonly number[]): () => boolean {
  const travel = new Map(threatIds.map((id) => [id, new AnchorTravel()]));
  return () => {
    let moved = false;
    for (const [id, anchor] of travel) {
      const position = bot.entities[id]?.position;
      if (position && anchor.add(position, false) > 0) moved = true;
    }
    return moved;
  };
}
