import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ActionOutput } from "../action.js";

export const SEND_MESSAGE = "send_message" as const;
export const SEND_MESSAGE_DESCRIPTION =
  "Send one public chat message, or with `to` a private whisper to one player online, and confirm that the connected bot observed the server's echo. Commands, multiline messages, `§` and control characters are not accepted (the server would disconnect the bot). With `shout`, on servers with localized chat, reaches everyone at a small hunger cost.";

/** Minecraft usernames: letters, digits and underscores, 1 to 16 characters (also the `/tell` target). */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/u;
/**
 * A whisper is sent as `/tell <name> <message>`, which Mineflayer splits into several commands past 256 characters; the
 * longest header (`/tell ` + a 16-letter name + a space) leaves this much for the text.
 */
export const MAX_WHISPER_LENGTH = 256 - "/tell ".length - 16 - 1;

/** The server disconnects a client for `§` and for U+0000-U+001F or U+007F in chat (no reconnect follows). */
const CHAT_REFUSED_CHARACTERS = /[§\u0000-\u001f\u007f]/u;

/** False when the text holds a character the server disconnects a client for: §, U+0000-U+001F or U+007F. */
export function isChatTextAccepted(text: string): boolean {
  return !CHAT_REFUSED_CHARACTERS.test(text);
}

/** A shout is sent as `/shout <message>`, one command of at most 256 characters. */
export const MAX_SHOUT_LENGTH = 256 - "/shout ".length;

const publicMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\r\n]*$/u, "Message must contain exactly one line.")
  .refine(
    isChatTextAccepted,
    "Message holds characters the server refuses (§ or control characters); remove them and send again.",
  )
  .refine((message) => !message.startsWith("/"), "Message must be public chat, not a command.")
  .describe("One public chat message, from 1 to 256 characters. Commands and line breaks are rejected.");

export const sendMessageInputSchema = z
  .strictObject({
    message: publicMessageSchema,
    to: z
      .string()
      .regex(USERNAME_PATTERN, "Whisper target must be a Minecraft username.")
      .optional()
      .describe("A player online to whisper to instead of speaking in public chat; the text is then at most 233 characters."),
    shout: z
      .boolean()
      .optional()
      .describe("Shout in public chat instead of talking: on servers with localized chat it reaches everyone, at a small hunger cost. Not with `to`."),
  })
  .refine((request) => request.to === undefined || request.message.length <= MAX_WHISPER_LENGTH, {
    message: `A whisper must be at most ${MAX_WHISPER_LENGTH} characters.`,
    path: ["message"],
  })
  .refine((request) => request.shout !== true || request.to === undefined, {
    message: "A shout is public: it cannot be combined with `to`.",
    path: ["shout"],
  })
  .refine((request) => request.shout !== true || request.message.length <= MAX_SHOUT_LENGTH, {
    message: `A shout must be at most ${MAX_SHOUT_LENGTH} characters.`,
    path: ["message"],
  });

export interface SendMessageRequest {
  readonly message: string;
  /** Set: a whisper to this player rather than public chat. */
  readonly to?: string;
  /** Set: sent as `/shout`, which reaches everyone on a server with localized chat. */
  readonly shout?: boolean;
}

export const sendMessageResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), message: z.string(), to: z.string().optional() }),
  z.strictObject({ status: z.literal("failed"), error: z.string(), message: z.string(), to: z.string().optional() }),
]);

export type SendMessageResult = z.output<typeof sendMessageResultSchema>;
export type SendMessageOutput = ActionOutput<typeof SEND_MESSAGE, SendMessageResult>;

export const sendMessageAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

export function parseSendMessageRequest(input: unknown): SendMessageRequest {
  return sendMessageInputSchema.parse(input ?? {});
}

export const sendMessageOutcomes = {
  playerNotOnline: (name: string) => `[PLAYER_NOT_ONLINE] No player named ${name} is online besides this bot, so the whisper was not sent.`,
  shoutUnavailable: () =>
    "[SHOUT_UNAVAILABLE] The server does not know /shout (no localized chat), so the message was not sent. Plain talk already reaches everyone there.",
  notObserved: (seconds: number) =>
    `[MESSAGE_NOT_OBSERVED] The bot did not observe the server's echo of its message within ${seconds} seconds.`,
  sendFailed: (cause: unknown) =>
    `[MESSAGE_SEND_FAILED] Mineflayer rejected the chat message: ${cause instanceof Error ? cause.message : String(cause)}`,
} as const;
