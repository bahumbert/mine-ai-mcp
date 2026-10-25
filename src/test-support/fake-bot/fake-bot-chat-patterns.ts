/**
 * The fake bot's chat patterns, as Mineflayer's `chat.js` keeps them for one-pattern sets: a `messagestr` line that
 * matches a registered pattern is emitted as `chat:<name>` with the parsed groups (`[groups]` with `parse`, the lines
 * otherwise); a pattern without `repeat` is dropped after its first match, and `removeChatPattern` forgets one.
 */
import type { FakeBot } from "./fake-bot.js";

type ChatPattern = { readonly name: string; readonly pattern: RegExp; readonly repeat: boolean; readonly parse: boolean };

/** Give `bot` `addChatPattern` and `removeChatPattern`, matched on every `messagestr` it emits. */
export function attachFakeChatPatterns(bot: FakeBot): void {
  const patterns: (ChatPattern | undefined)[] = [];
  bot.addChatPattern = (name, pattern, options) => {
    patterns.push({ name, pattern, repeat: options?.repeat ?? true, parse: options?.parse ?? false });
    return patterns.length - 1;
  };
  bot.removeChatPattern = (name) => {
    for (const [index, entry] of patterns.entries()) {
      if (entry !== undefined && (typeof name === "number" ? index === name : entry.name === name)) patterns[index] = undefined;
    }
  };
  bot.on("messagestr", (line: string) => {
    for (const [index, entry] of patterns.entries()) {
      const match = entry?.pattern.exec(line);
      if (!entry || !match) continue;
      bot.emit(`chat:${entry.name}` as never, (entry.parse ? [match.slice(1)] : [line]) as never);
      if (!entry.repeat) patterns[index] = undefined;
    }
  });
}
