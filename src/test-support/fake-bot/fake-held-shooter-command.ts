// The measured zero-speed skeleton command and its stored tellraw readback.
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";

/** Answer only the command sequence measured by contract held-shooter on vanilla 1.21.4. */
export function attachHeldShooterCommands(bot: FakeBot, server: FakeServer): void {
  const messages = (createRequire(import.meta.url)("prismarine-chat") as (registry: Bot["registry"]) => { fromNotch(json: string): Parameters<Bot["emit"]>[1] })(bot.registry);
  let held = false;
  const storage = new Map<string, number>();
  bot.chat = (command) => {
    server.answer(() => {
      const off = server.onTick(() => { off(); runCommand(); });
    });
    const runCommand = () => {
      if (command === "/attribute @e[type=minecraft:skeleton,limit=1,sort=nearest] minecraft:movement_speed base set 0") {
        held = Object.values(bot.entities).some((entity) => entity.name === "skeleton");
        return;
      }
      const stored = command.match(/^\/execute store success storage (\S+) (\S+) int 1 store result storage \1 (\S+) int 1 run attribute @e\[type=minecraft:skeleton,limit=1,sort=nearest\] minecraft:movement_speed get 100000$/);
      if (stored && held) {
        storage.set(`${stored[1]}:${stored[2]}`, 1);
        storage.set(`${stored[1]}:${stored[3]}`, 0);
        return;
      }
      if (!command.startsWith("/tellraw @s ")) return;
      let json: { text?: string; extra?: Array<{ text?: string; storage?: string; nbt?: string }> };
      try { json = JSON.parse(command.slice("/tellraw @s ".length)); } catch { return; }
      if (typeof json.text !== "string" || !Array.isArray(json.extra)) return;
      const parts = json.extra.map((part) => part.text ?? storage.get(`${part.storage}:${part.nbt}`));
      if (parts.some((part) => part === undefined)) return;
      const text = `${json.text}${parts.join("")}`;
      const message = messages.fromNotch(JSON.stringify({ text }));
      bot.emit("messagestr", text, "system", message as never);
    };
  };
}
