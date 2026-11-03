/** Command lines players type for the launcher (`!bots`): the ring the host serves them from, and the rule that spots one. */
import { randomUUID } from "node:crypto";

/** One chat or whisper line a player typed that is a command for the launcher, not talk for the bot. */
export interface ChatCommandLine {
  readonly username: string;
  readonly channel: "chat" | "whisper";
  readonly message: string;
}

export interface ChatCommandEntry extends ChatCommandLine {
  readonly seq: number;
  /** ISO time the runtime heard the line. */
  readonly at: string;
}

export interface ChatCommandBatch {
  readonly epoch: string;
  readonly lastSeq: number;
  readonly commands: ChatCommandEntry[];
}

/**
 * The newest command lines this runtime heard, for the launcher to poll (`GET /chat-commands`). The `epoch` is new
 * with every runtime process, so a poller that sees it change knows `seq` started again from 1.
 */
export class ChatCommandRing {
  readonly epoch = randomUUID();
  readonly #capacity: number;
  readonly #now: () => Date;
  readonly #entries: ChatCommandEntry[] = [];
  #lastSeq = 0;

  constructor(capacity = 50, now: () => Date = () => new Date()) {
    this.#capacity = capacity;
    this.#now = now;
  }

  push(line: ChatCommandLine): void {
    this.#lastSeq += 1;
    this.#entries.push({ seq: this.#lastSeq, ...line, at: this.#now().toISOString() });
    if (this.#entries.length > this.#capacity) this.#entries.shift();
  }

  /** The kept lines past `seq` (all of them for `undefined`), oldest first. */
  after(seq: number | undefined): ChatCommandBatch {
    const past = seq ?? 0;
    return { epoch: this.epoch, lastSeq: this.#lastSeq, commands: this.#entries.filter((entry) => entry.seq > past) };
  }
}

/**
 * A command line is the prefix then the word `bot` or `bots`, in any case, then a space or the end of the text
 * (spec in-game-bot-commands D1). The same rule is in `launcher/src/listener/listener.ts` (the listener) and
 * `launcher/src/chat/parse.ts` (`isCommandLine`): change the three together. Other `!` lines (`!discord`) are chat.
 */
export function isChatCommandLine(text: string, prefix: string): boolean {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escaped}bots?(\\s|$)`, "iu").test(text);
}
