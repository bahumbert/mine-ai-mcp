// The prompt budget: token budget per tier, the ledger of reserved room, and `fitPrompt` which shrinks a prompt to fit.
import type { MindTier } from "./brain-log.ts";

/**
 * The prompt budget of the brain (spec 2026-11-06-p4-02a-prompt-budget): a first-turn token budget per tier, a ledger
 * of the room promised to features not landed yet, and `fitPrompt`, which shrinks a user message made of parts until it
 * fits. The system prompt is never cut: a cut persona is what Ollama does to us when a prompt passes the window.
 */

/** First-turn prompt tokens a tier may use (spec D1, open choice 1). */
export const PROMPT_BUDGET: Readonly<Record<MindTier, number>> = {
  chat: 6000,
  // The work tier: 6400 for the situation event part (plan 2026-11-15-p4-18-night-reflex-l2 T5, master decision 2026-11-16);
  // 6500 for the house-template build line after the phase5-poc merge: own-family template ids only and trimmed prose
  // still measured 6343 against 6250 at the worst case (owner 2026-11-22).
  work: 6500,
  goal: 6000,
  narrate: 6000,
  sign: 6000,
  // Conversation openings and gists: their parts are never shrunk (no shrink order), the budget only tells a prompt that runs over.
  conversation: 6000,
};

/** Window kept for the reply, its thinking and up to six repair rounds (measured growth max 874 tokens). */
export const REPLY_RESERVE = 2048;
/** The smallest budget: a window this small cannot hold the system prompt anyway, so the parts go to their floors. */
export const MIN_BUDGET = 1024;
/** Characters per token until a model's own replies give a ratio (under the measured p1 of 3.48: errs high). */
export const DEFAULT_CHARS_PER_TOKEN = 3.4;
/** One cap on the activity hints of the goal prompt (spec D3). */
export const HINTS = { lines: 6, chars: 1600 } as const;

/** Room promised to a Phase 4 line that has not landed yet. */
export interface Reservation {
  readonly feature: string;
  readonly tiers: readonly MindTier[];
  readonly tokens: number;
}

/**
 * The ledger. A feature claims its room by adding its line as a part (with shrink levels), adding it to the
 * worst-case fixtures (`prompt-fixtures.ts`) of the ledger test in `prompt-parts.test.ts`, and deleting its row here in the same commit. A feature
 * needing more than its row changes `PROMPT_BUDGET` in its own commit, visibly. Token figures are estimates.
 */
export const RESERVED: readonly Reservation[] = [
  { feature: "P4-13 what is where", tiers: ["work", "goal"], tokens: 150 },
  { feature: "P4-14 long-goal progress", tiers: ["goal"], tokens: 150 },
];

/** The tokens of the {@link RESERVED} rows that name a tier. */
export function reservedTokens(tier: MindTier): number {
  return RESERVED.filter((row) => row.tiers.includes(tier)).reduce((sum, row) => sum + row.tokens, 0);
}

/** One block of a user message, with the shrink levels it can take. */
export interface PromptPart {
  readonly key: string;
  /** Level 0 is today's text; higher levels are shorter. "" omits the part. */
  readonly render: (level: number) => string;
  /** 0 = never shrunk. */
  readonly maxLevel: number;
  /** What the log says when the part is shrunk; default `${key} level ${level}`. */
  readonly label?: (level: number) => string;
  /** The separator before the part; default "\n\n". */
  readonly before?: string;
}

/** A prompt as it will be sent. */
export interface FittedPrompt {
  /** The user message. */
  readonly text: string;
  /** Estimated first-turn prompt tokens (system and text). */
  readonly estimated: number;
  /** The budget the estimate was fitted into. */
  readonly tokens: number;
  /** The labels of the parts shown shorter than their level 0. */
  readonly shrunk: readonly string[];
  /** Still over the budget with every part at its floor. */
  readonly overBudget: boolean;
}

const DEFAULT_SEPARATOR = "\n\n";

/** Tokens a text of that many characters takes at that ratio. */
export function estimateTokens(characters: number, charsPerToken: number): number {
  return Math.ceil(characters / charsPerToken);
}

/** The budget of a call: the table value, cut to the window minus the reply room, never under {@link MIN_BUDGET}. */
export function budgetFor(tier: MindTier, window: number | null): number {
  if (window === null) return PROMPT_BUDGET[tier];
  return Math.max(MIN_BUDGET, Math.min(PROMPT_BUDGET[tier], window - REPLY_RESERVE));
}

/** The user message of the parts at these levels: the non-empty renders, each after its separator (none before the first). */
function renderParts(parts: readonly PromptPart[], levels: readonly number[]): string[] {
  return parts.map((part, index) => part.render(levels[index] ?? 0));
}

function joinRendered(parts: readonly PromptPart[], rendered: readonly string[]): string {
  let text = "";
  parts.forEach((part, index) => {
    const piece = rendered[index] ?? "";
    if (piece === "") return;
    text += text === "" ? piece : (part.before ?? DEFAULT_SEPARATOR) + piece;
  });
  return text;
}

/**
 * Raises one part by one useful level: skips the levels that render the same text as the current one. Returns the new
 * level, or null when no higher level renders anything different (the part is at its floor).
 */
function nextUsefulLevel(part: PromptPart, level: number): number | null {
  const current = part.render(level);
  for (let next = level + 1; next <= part.maxLevel; next += 1) {
    if (part.render(next) !== current) return next;
  }
  return null;
}

/**
 * Fits a user message into `tokens` (estimated at `charsPerToken`). While it is over, one part of `order` goes up one
 * level, walking `order` cyclically so every list gets shorter before one is cut hard; it stops as soon as it fits. Parts
 * with `maxLevel` 0 or outside `order` are never shrunk. All parts at their floor and still over: sent as it is, marked
 * `overBudget`.
 */
export function fitPrompt(
  system: string,
  parts: readonly PromptPart[],
  order: readonly string[],
  tokens: number,
  charsPerToken: number,
): FittedPrompt {
  const levels = parts.map(() => 0);
  // Each part once, at the place of its first mention: a key named twice would keep the loop below from ever ending.
  const shrinkable = [...new Set(order.map((key) => parts.findIndex((part) => part.key === key)))].filter(
    (index) => index >= 0 && (parts[index]?.maxLevel ?? 0) > 0,
  );
  const atFloor = new Set<number>();
  let rendered = renderParts(parts, levels);
  let text = joinRendered(parts, rendered);
  let estimated = estimateTokens(system.length + text.length, charsPerToken);
  let cursor = 0;
  while (estimated > tokens && atFloor.size < shrinkable.length) {
    const partIndex = shrinkable[cursor % shrinkable.length] as number;
    cursor += 1;
    if (atFloor.has(partIndex)) continue;
    const part = parts[partIndex] as PromptPart;
    const next = nextUsefulLevel(part, levels[partIndex] as number);
    if (next === null) {
      atFloor.add(partIndex);
      continue;
    }
    levels[partIndex] = next;
    if (next >= part.maxLevel) atFloor.add(partIndex);
    rendered = renderParts(parts, levels);
    text = joinRendered(parts, rendered);
    estimated = estimateTokens(system.length + text.length, charsPerToken);
  }
  const shrunk = parts.flatMap((part, index) => {
    const level = levels[index] as number;
    if (level === 0 || rendered[index] === part.render(0)) return [];
    return [part.label ? part.label(level) : `${part.key} level ${level}`];
  });
  return { text, estimated, tokens, shrunk, overBudget: estimated > tokens };
}

/** The calibration clamp (4 as the monitor, `monitor/src/mind.ts`) and how many calls of a model it remembers. */
const MIN_CHARS_PER_TOKEN = 2.5;
const MAX_CHARS_PER_TOKEN = 4;
const CALIBRATION_SAMPLES = 50;
/** A server count at or over this share of the window was taken after Ollama cut the prompt: not a sample. */
const CUT_SHARE_OF_WINDOW = 0.95;

/**
 * What each model has shown about itself: characters per token (the median of its last {@link CALIBRATION_SAMPLES}
 * first replies that came with a server count, clamped) and the context window it last reported.
 */
export class ModelCalibration {
  private readonly ratios = new Map<string, number[]>();
  private readonly windows = new Map<string, number>();

  /** The last window the model reported, null before its first answer (or when it never says). */
  window(model: string): number | null {
    return this.windows.get(model) ?? null;
  }

  /** The median ratio of the model's samples clamped to 2.5..4; {@link DEFAULT_CHARS_PER_TOKEN} before any sample. */
  charsPerToken(model: string): number {
    const samples = [...(this.ratios.get(model) ?? [])].sort((a, b) => a - b);
    if (samples.length === 0) return DEFAULT_CHARS_PER_TOKEN;
    const middle = samples.length >> 1;
    const median = samples.length % 2 === 1 ? samples[middle]! : (samples[middle - 1]! + samples[middle]!) / 2;
    return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, median));
  }

  /** Reads the first reply of a call: `characters` of system and user message against the server's `promptTokens`. */
  learn(model: string, characters: number, promptTokens: number | null, contextTokens: number | null): void {
    if (contextTokens !== null) this.windows.set(model, contextTokens);
    if (promptTokens === null || promptTokens <= 0) return;
    if (contextTokens !== null && promptTokens >= CUT_SHARE_OF_WINDOW * contextTokens) return;
    const samples = this.ratios.get(model) ?? [];
    samples.push(characters / promptTokens);
    this.ratios.set(model, samples.slice(-CALIBRATION_SAMPLES));
  }
}

/**
 * Whole lines in order until a cap. The first line and every line `keep` marks are always kept and count in the caps;
 * a single line over `maxChars` is kept whole.
 */
export function capLines(
  lines: readonly string[],
  maxLines: number,
  maxChars: number,
  keep: (index: number) => boolean = () => false,
): string[] {
  const chosen = new Set<number>();
  let characters = 0;
  lines.forEach((line, index) => {
    if (index === 0 || keep(index)) {
      chosen.add(index);
      characters += line.length;
    }
  });
  for (let index = 0; index < lines.length; index += 1) {
    if (chosen.has(index)) continue;
    const length = (lines[index] as string).length;
    if (chosen.size + 1 > maxLines || characters + length > maxChars) break;
    chosen.add(index);
    characters += length;
  }
  return lines.filter((_, index) => chosen.has(index));
}

/** The text cut to `maxChars` characters, the last one an ellipsis; unchanged when it already fits. */
export function cut(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
