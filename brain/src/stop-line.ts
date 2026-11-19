// A stop word: a line that is only the owner's stop word acts in the poll that reads it, without a model call (spec
// 2026-11-18-model-call-lanes D3). The words are the owner's setting (`--stop-words`, env `MINE_AI_STOP_WORDS`); none is
// built in, and what a stop does is the chat tier's own `stop` route (`Agent.stopAndRest`), only earlier.

/** A text as stop words and lines are compared: everything but letters, digits and spaces taken out, spaces collapsed and trimmed. */
function bare(text: string): string {
  return text.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/gu, " ").trim();
}

/** The stop words of a setting: comma separated, lower-cased, read as a line is (punctuation left out, spaces collapsed), empty items dropped. */
export function parseStopWords(raw: string | undefined): readonly string[] {
  return (raw ?? "").split(",").map((word) => bare(word.toLowerCase())).filter((word) => word !== "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Whether the line is a stop line: the text lower-cased, each name of `names` taken out as a whole word, everything but
 * letters, digits and spaces taken out, spaces collapsed, equals one stop word. Whose stop it is, is
 * {@link stopLineIsMine}'s question. No stop word set: never.
 */
export function isStopLine(text: string, stopWords: readonly string[], names: readonly string[]): boolean {
  if (stopWords.length === 0) return false;
  let rest = text.toLowerCase();
  for (const name of names) {
    if (name === "") continue;
    rest = rest.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name.toLowerCase())}(?![\\p{L}\\p{N}_])`, "gu"), " ");
  }
  const line = bare(rest);
  return line !== "" && stopWords.includes(line);
}

/** What decides whether a stop line is this character's. */
export interface StopLineFacts {
  /** The characters and players the line names (not its speaker), as spelled in the game. */
  readonly named: readonly string[];
  /** This character's username. */
  readonly self: string;
  readonly channel: "chat" | "whisper";
  /** The stack holds an order of the speaker. */
  readonly speakerHasOrder: boolean;
  /** The speaker's last line naming a character named another one than this one, lately (`WhoWasNamed`). */
  readonly talkedToOther: boolean;
  /** This character hears the speaker at all (`listensTo`, or an agent inside its conversation). */
  readonly heard: boolean;
}

/**
 * Whether the stop line is this character's: false when it does not hear the speaker; true when the line names it;
 * false when it names anyone else; else true for a whisper, or when the speaker has an order on it and was not lately
 * talking to another character. A public stop naming nobody from a speaker with no order here is left to the chat tier.
 */
export function stopLineIsMine(facts: StopLineFacts): boolean {
  if (!facts.heard) return false;
  const self = facts.self.toLowerCase();
  if (facts.named.some((name) => name.toLowerCase() === self)) return true;
  if (facts.named.length > 0) return false;
  return facts.channel === "whisper" || (facts.speakerHasOrder && !facts.talkedToOther);
}
