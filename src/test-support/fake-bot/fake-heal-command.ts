// The instant heal an op command gives (contract check `fire-block-burn` heals the body between its cases).
import type { FakeBot } from "./fake-bot.js";
import type { FakeCombat } from "./fake-bot-combat.js";
import type { FakeServer } from "./fake-server.js";

/** `/effect give @s minecraft:instant_health <seconds> <level> true`: measured on 1.21.4 only as far as the health reaching 19 or more within 400 ticks after a burn that left 10.8 (the exact tick is not measured). */
const INSTANT_HEALTH_COMMAND = /^\/effect give @s minecraft:instant_health \d+ \d+ true$/;
const FULL_HEALTH = 20;

/** Answer the instant-health command one server tick after it is sent, with full health (food as it is); every other command goes on to what was attached before. */
export function attachHealCommand(bot: FakeBot, server: FakeServer, combat: FakeCombat): void {
  const previous = bot.chat.bind(bot);
  bot.chat = (message) => {
    previous(message);
    if (!INSTANT_HEALTH_COMMAND.test(message)) return;
    server.answer(() => {
      const off = server.onTick(() => {
        off();
        combat.setHealth(FULL_HEALTH);
      });
    });
  };
}
