// Which lane of the model queue and which priority each model call gets, and when slots can be kept for chat (spec 2026-11-18 D1, D2).
import type { MindTier } from "./brain-log.ts";
import type { ModelLane } from "./chat-model.ts";

/** What the chat tier knows about the line it answers, which decides how soon the answer is wanted. */
export interface LineFacts {
  /** The speaker is another agent of the project, not a person. */
  readonly fromAgent: boolean;
  /** The line is to this bot: it names her, or it is a whisper. */
  readonly addressed: boolean;
}

/**
 * Why `chatSlots` of `slots` model slots cannot be kept for chat, or null when it can: a whole number from 0, below
 * the slots, and 0 when the slots are unknown (a slot count is needed to keep part of it).
 */
export function chatSlotsRefusal(slots: number | null, chatSlots: number): string | null {
  if (!Number.isInteger(chatSlots) || chatSlots < 0) return `${chatSlots} is not a whole number from 0`;
  if (chatSlots === 0) return null;
  if (slots === null) return `${chatSlots} slots cannot be kept for chat when the model slots are unknown (set --model-slots)`;
  if (chatSlots >= slots) return `${chatSlots} kept for chat leaves no slot for the other calls (${slots} model slots); use fewer than ${slots}`;
  return null;
}

/**
 * The lane and the order of a model call (spec 2026-11-18 D2; lower priority goes first). A person waits for the chat
 * tier, so only its replies to a person's line use the slots kept for chat: 0 for a line to the bot, 1 for a line to
 * everyone (every bot in range asks). The other calls share the rest: 2 the chat tier on another agent's line, 3 a
 * conversation line or a narration (read at leisure), 4 goals and work (the bots' own pace).
 */
export function tierCall(tier: MindTier, line?: LineFacts): { readonly lane: ModelLane; readonly priority: number } {
  switch (tier) {
    case "chat":
      if (line === undefined) return { lane: "chat", priority: 0 };
      if (line.fromAgent) return { lane: "shared", priority: 2 };
      return { lane: "chat", priority: line.addressed ? 0 : 1 };
    case "conversation":
    case "narrate":
    case "sign":
      return { lane: "shared", priority: 3 };
    case "goal":
    case "work":
      return { lane: "shared", priority: 4 };
  }
}
