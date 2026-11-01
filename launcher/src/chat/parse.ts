// Chat command lines: what is a command, what it asks, and who said it on the local server's console (spec D1, D3).

/** A Minecraft account name as the server accepts it; also the only shape that may reach a `tellraw` line. */
export const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/u;

export type ChatCommand = { kind: "list" } | { kind: "start"; name: string } | { kind: "stop"; name: string } | { kind: "help" };

/** No persona name is this long; a longer command line is not read (spec D1). */
const MAX_COMMAND_LINE_LENGTH = 100;

/** Sender and text of a signed or unsigned player chat line; anchored at the logger prefix so text cannot fake a sender (spec D3). */
const CONSOLE_CHAT_LINE = /^\[[^\]]*\] \[Server thread\/INFO\]: (?:\[Not Secure\] )?<([A-Za-z0-9_]{1,16})> (.*)$/u;

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Whether a chat line is one of our command lines: `^\s*<prefix>bots?(\s|$)`, any case. The same rule is applied in
 * `src/runtime/chat-commands.ts` (keeps the line from the brains, `src/` cannot import `launcher/`) and used by
 * `launcher/src/listener/listener.ts`; change this and the runtime's together. Not capped in length: a long command line is kept from the brains too.
 */
export function isCommandLine(text: string, prefix: string): boolean {
  return new RegExp(`^\\s*${escapeForRegExp(prefix)}bots?(\\s|$)`, "iu").test(text);
}

/** The command a command line asks for; null when the text is no command line or is over 100 characters (ignored). */
export function parseChatCommand(text: string, prefix: string): ChatCommand | null {
  if (text.length > MAX_COMMAND_LINE_LENGTH || !isCommandLine(text, prefix)) return null;
  const words = text.trim().split(/\s+/u);
  const keyword = words[0]!.slice(prefix.length).toLowerCase();
  if (keyword === "bots" && words.length === 1) return { kind: "list" };
  const action = words[1]?.toLowerCase();
  if (keyword === "bot" && words.length === 3 && (action === "start" || action === "stop")) return { kind: action, name: words[2]! };
  return { kind: "help" };
}

/** The sender and text of a player chat line in the local server's console log; null for every other line. */
export function parseConsoleChat(line: string): { username: string; message: string } | null {
  const match = CONSOLE_CHAT_LINE.exec(line);
  return match ? { username: match[1]!, message: match[2]! } : null;
}
