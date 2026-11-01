// The listener's bare mineflayer client: reads chat and whispers on a server with no bot of ours in, reports command
// lines and whispers answers. No plugin, no runtime, no brain, no model (spec 2026-10-30-in-game-bot-commands D4).
import { isCommandLine, PLAYER_NAME } from "../chat/parse.ts";

/** The part of mineflayer's `Bot` the listener uses; a test supplies an `EventEmitter` with the same events. */
export interface ListenerBot {
  readonly username: string;
  on(event: "spawn" | "end", handler: (reason?: string) => void): unknown;
  on(event: "chat" | "whisper", handler: (username: string, message: string) => void): unknown;
  // mineflayer's typings say `string`, but a 1.21.4 play-state kick arrives as an NBT compound (`kick.js` passes the packet's reason as it came).
  on(event: "kicked", handler: (reason: unknown, loggedIn: boolean) => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
  whisper(to: string, message: string): void;
}

/** One JSON line of the listener's stdout; the launcher's `ListenerSupervisor` reads the same shapes. */
export type ListenerEvent =
  | { readonly kind: "joined" }
  | { readonly kind: "command"; readonly username: string; readonly channel: "chat" | "whisper"; readonly message: string }
  | { readonly kind: "ended"; readonly reason: string; readonly duplicate: boolean; readonly kicked: boolean };

export interface ListenerIo {
  emit(event: ListenerEvent): void;
  readonly prefix: string;
}

const DUPLICATE_LOGIN_KEY = "multiplayer.disconnect.duplicate_login";

// Same text rules as `send_message` (`src/actions/send-message/contract.ts`: the server disconnects a client for `§`
// and for U+0000-U+001F or U+007F in chat; a whisper text is at most 233 characters). Copied: the launcher does not import `src/`.
const MAX_WHISPER_LENGTH = 233;
const REFUSED_CHARACTERS = /[§\u0000-\u001f\u007f]/u;

/** An NBT-encoded text component (`{ type: "compound", value: { translate: { type: "string", value } } }`) as the plain JSON object it stands for. */
function plainFromNbt(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(plainFromNbt);
  if (node === null || typeof node !== "object") return node;
  const entries = node as Record<string, unknown>;
  if (typeof entries["type"] === "string" && "value" in entries) return plainFromNbt(entries["value"]);
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, plainFromNbt(value)]));
}

/** A kick reason as it came (JSON string, plain text or NBT compound) as readable text, and whether it is the duplicate-login kick. */
function describeKick(reason: unknown): { reason: string; duplicate: boolean } {
  let component: unknown = reason;
  if (typeof reason === "string") {
    try {
      component = JSON.parse(reason);
    } catch {
      return { reason, duplicate: false };
    }
  }
  const plain = plainFromNbt(component);
  if (plain === null || typeof plain !== "object") return { reason: String(plain), duplicate: false };
  const duplicate = (plain as Record<string, unknown>)["translate"] === DUPLICATE_LOGIN_KEY;
  const readable = componentText(plain);
  return { reason: readable === "" ? JSON.stringify(plain) : readable, duplicate };
}

/** The words a text component shows: its `text`, or its `translate` key with the `with` arguments, then its `extra` parts. */
function componentText(component: unknown): string {
  if (typeof component === "string") return component;
  if (Array.isArray(component)) return component.map(componentText).join("");
  if (component === null || typeof component !== "object") return "";
  const fields = component as Record<string, unknown>;
  const translate = typeof fields["translate"] === "string" ? fields["translate"] : "";
  const args = Array.isArray(fields["with"]) ? fields["with"].map(componentText).filter((text) => text !== "") : [];
  const own = typeof fields["text"] === "string" ? fields["text"] : args.length > 0 ? `${translate}: ${args.join(", ")}` : translate;
  return own + componentText(fields["extra"]);
}

/** Connects the listener's events to `io`; the returned `whisper` answers a player through the bot. */
export function runListener(bot: ListenerBot, io: ListenerIo): { whisper(to: string, message: string): void } {
  let joined = false;
  let ended = false;
  const emit = (event: ListenerEvent): void => {
    if (!ended) io.emit(event);
  };
  const end = (reason: string, duplicate: boolean, kicked: boolean): void => {
    if (ended) return;
    io.emit({ kind: "ended", reason, duplicate, kicked });
    ended = true;
  };
  const hear = (channel: "chat" | "whisper") => (username: string, message: string): void => {
    if (username === bot.username || !isCommandLine(message, io.prefix)) return;
    emit({ kind: "command", username, channel, message });
  };

  bot.on("spawn", () => {
    if (joined) return;
    joined = true;
    emit({ kind: "joined" });
  });
  bot.on("chat", hear("chat"));
  bot.on("whisper", hear("whisper"));
  bot.on("kicked", (reason) => {
    const kick = describeKick(reason);
    end(kick.reason, kick.duplicate, true);
  });
  bot.on("end", (reason) => end(reason ?? "connection ended", false, false));
  // mineflayer raises `error` for a refused connection; `end` normally follows, but one `ended` is promised either way.
  bot.on("error", (error) => end(error.message, false, false));

  return {
    whisper(to, message) {
      const refused = message.length === 0 || message.length > MAX_WHISPER_LENGTH || REFUSED_CHARACTERS.test(message);
      if (refused || !PLAYER_NAME.test(to)) return;
      bot.whisper(to, message);
    },
  };
}
