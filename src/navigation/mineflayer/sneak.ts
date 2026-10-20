import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";

/**
 * Whether this protocol's server reads the shift from `entity_action` (up to 1.21.5; minecraft-data feature
 * `sneakUsesEntityAction`) rather than from the shift bit of `player_input` (1.21.6 on). Asked of the protocol's data by
 * the bot's version: a bot that has not logged in has none, and nothing to write to.
 */
function readsShiftFromEntityAction(bot: Bot): boolean {
  return bot.version !== undefined && minecraftData(bot.version)?.supportFeature("sneakUsesEntityAction") === true;
}

/**
 * Write the shift key to the server, in the packet this protocol reads it from. Not told by `newPlayerInputPacket`:
 * 1.21.2 to 1.21.5 send `player_input` too, but the server reads it there for minecart steering and nothing else.
 */
export function writeShiftKey(bot: Bot, down: boolean): void {
  if (readsShiftFromEntityAction(bot)) {
    bot._client.write("entity_action", { entityId: bot.entity.id, actionId: down ? 0 : 1, jumpBoost: 0 });
  } else {
    bot._client.write("player_input", { inputs: { shift: down } });
  }
}

/**
 * Set the sneak control and tell the server so.
 *
 * On 1.21.4 the server's sneaking flag moves on the client-command packet, and on the sneaking bit Mineflayer stamps on
 * every attack from the control at that instant. So a control set through Mineflayer alone leaves the server ignorant
 * until an attack lands mid-crouch, which latches the server crouched until the next attack says otherwise. Every
 * writer that crouches the body sends the shift packet here, on every call, so the release always arrives whatever
 * the server believed before. This compatibility write belongs in Mineflayer's setControlState; remove it once the
 * pinned Mineflayer sends the sneaking action itself. From 1.21.6 Mineflayer's own `player_input` is the one the server
 * reads, and a second one written here would zero the walking inputs for a tick: nothing is added.
 */
export function setSneaking(bot: Bot, sneaking: boolean): void {
  bot.setControlState("sneak", sneaking);
  if (readsShiftFromEntityAction(bot)) writeShiftKey(bot, sneaking);
}
