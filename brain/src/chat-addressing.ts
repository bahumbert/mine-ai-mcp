// Who a chat line is for: the names it calls, the exchange with the speaker, the others chatting, the chat prompt's name lists (ADR-017).
import type { ChatInput, ChatLine, StepRecord } from "./mind.ts";

/**
 * Where the last explore for `block` said one is known ("the nearest oak_log you know of is <where>, around x z: ..."),
 * or null: none explored for it, its result named none, or a `get_items` of it failed since (then it is not fetchable
 * and exploring is fair). From the step records only.
 */
export function knownByEarlierExplore(steps: readonly StepRecord[], block: string): string | null {
  for (const record of steps.toReversed()) {
    if (record.step.startsWith("get ") && record.outcome === "failed" && record.step.split(/[^a-z0-9_]+/u).includes(block)) return null;
    if (!record.step.startsWith("explore ") || !record.step.endsWith(` for ${block}`)) continue;
    // Done or failed: a walk that stopped still names the block it knows (`skills/explore.ts` adds that before it decides the outcome).
    return record.detail.includes("you know of") ? /you know of is (.*?): get_items /u.exec(record.detail)?.[1] ?? record.detail : null;
  }
  return null;
}

/** Lines back a conversation with her still counts as going on... */
const EXCHANGE_LINES = 6;
/** ... and how long since its last line (a pause this long ends it). */
const EXCHANGE_MS = 3 * 60_000;

/**
 * The speaker's latest exchange with her within the last {@link EXCHANGE_LINES} lines: a line of theirs spoken to her (as
 * she read it) or one of hers answering them; undefined when there is none.
 */
function lastExchange(input: Pick<ChatInput, "message" | "persona" | "history">): ChatLine | undefined {
  const [speaker, self] = [input.message.username.toLowerCase(), input.persona.username.toLowerCase()];
  return input.history.slice(-EXCHANGE_LINES).findLast((line) => {
    const by = line.speaker.toLowerCase();
    const to = (line.to ?? []).map((name) => name.toLowerCase());
    return (by === speaker && to.includes(self)) || (by === self && to.includes(speaker));
  });
}

/**
 * Whether a conversation between the speaker and her is going on: within the last {@link EXCHANGE_LINES} lines and
 * {@link EXCHANGE_MS}, the speaker spoke to her (as she read it) or she answered the speaker. Only an addressed line
 * starts one, so her own answers cannot start one by themselves.
 */
export function talkingWithHer(input: Pick<ChatInput, "message" | "persona" | "history">, now = Date.now()): boolean {
  const last = lastExchange(input);
  return last !== undefined && (last.at === undefined || now - last.at <= EXCHANGE_MS);
}

/**
 * Who else spoke to the speaker since the speaker's last exchange with her, within the last {@link EXCHANGE_LINES}
 * lines (the latest one); null when nobody did.
 */
function answeringSomeoneElse(input: Pick<ChatInput, "message" | "persona" | "history">): string | null {
  const [speaker, self] = [input.message.username.toLowerCase(), input.persona.username.toLowerCase()];
  for (const line of input.history.slice(-EXCHANGE_LINES).reverse()) {
    const by = line.speaker.toLowerCase();
    const to = (line.to ?? []).map((name) => name.toLowerCase());
    if ((by === speaker && to.includes(self)) || (by === self && to.includes(speaker))) return null;
    if (by !== speaker && by !== self && to.includes(speaker)) return line.speaker;
  }
  return null;
}

/** Who spoke to the speaker just before a message that is not addressed to her (see {@link answeringSomeoneElse}); null otherwise. */
export function answeredElsewhere(input: ChatInput): string | null {
  return input.message.addressed ? null : answeringSomeoneElse(input);
}

/** Whether `text` holds `name` as a word, as the runtime finds her own name (letters, digits, underscores). */
export function namesWord(text: string, name: string): boolean {
  return text.toLowerCase().split(/[^a-z0-9_]+/u).includes(name.toLowerCase());
}

/** A character of a name, as the runtime's word test counts it (any language's letters, digits, underscores). */
function isNameChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

/** Whether `text` has `name`, as a whole word, at `at`. */
function nameAt(text: string, at: number, name: string): boolean {
  return name.length > 0 && text.slice(at, at + name.length).toLowerCase() === name.toLowerCase() && !isNameChar(text[at + name.length]) && !isNameChar(text[at - 1]);
}

/**
 * The known names a message calls, as spelled in `names`, once each, in the order they appear (ADR-017 point 7): a name
 * as a whole word followed by optional spaces and `,` or `:`, wherever it stands, or written `@name`. Names and
 * punctuation only, never words: "Opus, Vex is going through the ocean" calls Opus and merely names Vex, and "Ayla, get
 * wood and Vex, mine stone" calls both. A name before a comma that is not a call ("nice work, thanks Vex, see you") is
 * read as one; a call without the comma ("... and Vex mine stone") is missed.
 */
export function calledNames(text: string, names: readonly string[]): string[] {
  const called: string[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const name = names.find((candidate) => nameAt(text, at, candidate));
    if (name === undefined || called.includes(name)) continue;
    if (text[at - 1] === "@" || [",", ":"].includes(text.slice(at + name.length).trimStart()[0] ?? "")) called.push(name);
  }
  return called;
}

/**
 * The known names the message calls when it calls others and not her yet names her inside a sentence (or is addressed to
 * her by the runtime); empty otherwise. The one condition for the fact in the prompt and for the reply check.
 */
export function calledOthers(input: ChatInput): string[] {
  const { message, persona } = input;
  const called = calledNames(message.message, knownNamesOf(input));
  const herself = called.some((name) => name.toLowerCase() === persona.username.toLowerCase());
  return herself || !(message.addressed || namesWord(message.message, persona.username)) ? [] : called;
}

/** The names the chat tier knows: hers, players online, speakers and `to` names in the history, and the configured ones. */
function knownNamesOf(input: ChatInput): string[] {
  const unnamed = ["everyone", "unclear", "you"];
  const all = [input.persona.username, ...input.snapshot.players.map((player) => player.username), ...input.history.flatMap((line) => [line.speaker, ...(line.to ?? [])]), ...(input.knownNames ?? [])];
  const known: string[] = [];
  for (const name of all) {
    if (name.length > 0 && !unnamed.includes(name.toLowerCase()) && !known.some((other) => other.toLowerCase() === name.toLowerCase())) known.push(name);
  }
  return known;
}

/** Lines back a follow-up is looked for: the speaker's line just before, not one from long ago. */
const FOLLOW_UP_LINES = 3;

/**
 * Whom the speaker's previous line spoke to, when the new message names nobody (not her either), that line is among the
 * last {@link FOLLOW_UP_LINES}, she has not spoken since, and she read it as spoken to others (not everyone, not
 * unclear, not her); null otherwise. Her own earlier reading, kept on the history line.
 */
export function conversationGoingOn(input: ChatInput): readonly string[] | null {
  const { message, persona } = input;
  const names = [persona.username, ...input.snapshot.players.map((player) => player.username)];
  if (message.addressed || names.some((name) => namesWord(message.message, name))) return null;
  const recent = input.history.slice(-FOLLOW_UP_LINES);
  const index = recent.map((line) => line.speaker.toLowerCase()).lastIndexOf(message.username.toLowerCase());
  if (index === -1) return null;
  if (recent.slice(index + 1).some((line) => line.speaker.toLowerCase() === persona.username.toLowerCase())) return null;
  const to = recent[index]?.to ?? [];
  const self = persona.username.toLowerCase();
  if (to.length === 0 || to.some((name) => ["everyone", "unclear", self].includes(name.toLowerCase()))) return null;
  return to;
}

/**
 * What the chat history shows about the new message, as facts for the prompt (spec 2026-10-09-chat-handling, B; ADR-017):
 * a conversation with the speaker going on, the speaker's previous line spoken to someone else, someone else having
 * just spoken to the speaker. Empty when the history shows none. Read from the history's own fields, never from the
 * words of the message beyond whether it names a player.
 */
export function describeConversation(input: ChatInput, now = Date.now()): string {
  const { message } = input;
  const facts: string[] = [];
  const last = lastExchange(input);
  // Someone else speaking to the speaker after the exchange with her ended it: the two facts would contradict.
  const answering = answeredElsewhere(input);
  if (last !== undefined && answering === null && talkingWithHer(input, now)) {
    facts.push(`You are talking with ${message.username}${last.at === undefined ? "" : ` (your last exchange was ${Math.max(0, Math.round((now - last.at) / 1_000))} s ago)`}.`);
  }
  // The speaker's latest line naming a character, seen by every agent: a fact, whose reading is the model's.
  if (input.talkedTo !== undefined && input.talkedTo.name.toLowerCase() !== input.persona.username.toLowerCase()) {
    facts.push(`${message.username} was talking to ${input.talkedTo.name} ${input.talkedTo.secondsAgo} s ago; this line names nobody.`);
  }
  const ongoing = conversationGoingOn(input);
  if (ongoing !== null) facts.push(`${message.username}'s line just before this one spoke to ${ongoing.join(", ")}, not to you, and this message names nobody.`);
  if (answering !== null) facts.push(`${answering} spoke to ${message.username} just before this message, which names nobody.`);
  const called = calledOthers(input);
  if (called.length > 0) facts.push(`This message calls ${called.join(", ")} by name (a name followed by a comma or colon); it names you without calling you.`);
  if (!message.addressed && message.channel !== "whisper" && !talkingWithHer(input, now) && input.conversation === undefined) {
    facts.push(`This message does not name you, and you are not talking with ${message.username}: it is for you only if it asks or calls everyone around (a question or request to all); a remark, or a reply in a chat among others, is not.`);
  }
  return facts.length === 0 ? "" : `About this message:\n${facts.map((fact) => `- ${fact}`).join("\n")}`;
}

/** Whether the message names, as a word, a known name other than hers and its speaker's (see {@link knownNamesOf}). */
export function namesSomeoneElse(input: ChatInput): boolean {
  const [speaker, self] = [input.message.username.toLowerCase(), input.persona.username.toLowerCase()];
  return knownNamesOf(input).some((name) => ![speaker, self].includes(name.toLowerCase()) && namesWord(input.message.message, name));
}

/**
 * The other players (not her, not the speaker) who spoke in the last {@link EXCHANGE_LINES} lines and {@link EXCHANGE_MS},
 * when none of those lines spoke to her or was hers; empty otherwise. From the history's speakers and readings only
 * (ADR-017).
 */
export function othersChatting(input: Pick<ChatInput, "message" | "persona" | "history">, now = Date.now()): string[] {
  const [speaker, self] = [input.message.username.toLowerCase(), input.persona.username.toLowerCase()];
  const recent = input.history.slice(-EXCHANGE_LINES).filter((line) => line.at === undefined || now - line.at <= EXCHANGE_MS);
  if (recent.some((line) => line.speaker.toLowerCase() === self || (line.to ?? []).some((name) => name.toLowerCase() === self))) return [];
  const others: string[] = [];
  for (const line of recent) {
    if (line.speaker.toLowerCase() !== speaker && !others.some((name) => name.toLowerCase() === line.speaker.toLowerCase())) others.push(line.speaker);
  }
  return others;
}

/** The names the chat prompt never drops from the players list: the speaker, those the history shows, those the message names. */
export function namesToKeep(input: ChatInput): string[] {
  const inHistory = input.history.flatMap((line) => [line.speaker, ...(line.to ?? [])]);
  return [input.message.username, ...inHistory, ...knownNamesOf(input).filter((name) => namesWord(input.message.message, name))];
}
