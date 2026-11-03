/** The host's two routes for the launcher's chat commands: read the lines heard, whisper an answer. */
import type { Request, Response } from "express";
import { sendMessageInputSchema } from "../actions/send-message/contract.js";
import type { ChatCommandRing } from "../runtime/chat-commands.js";

/**
 * The launcher's header on its own control endpoint (`launcher/src/control.ts` CONTROL_HEADER), same value: `src/` must
 * not import `launcher/`. A web page cannot send a custom header without a preflight, which the host never answers.
 */
const CONTROL_HEADER = "x-mine-ai-control";

export interface ChatCommandRouteDeps {
  /** Null when the host has no `--chat-command-prefix`: both routes then answer 404. */
  readonly ring: ChatCommandRing | null;
  /** Whispers through `send_message`, so the server's echo is the proof; the error text is the action's own. */
  whisper(to: string, message: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * `GET /chat-commands?after=<seq>` serves the command lines the runtime kept out of the event log;
 * `POST /chat-commands/whisper` `{ to, message }` answers one back. Both are for the launcher, which polls.
 * Returns true when it answered, false for any other request.
 */
export function handleChatCommandRoute(request: Request, response: Response, deps: ChatCommandRouteDeps): boolean {
  const reading = request.method === "GET" && request.path === "/chat-commands";
  const whispering = request.method === "POST" && request.path === "/chat-commands/whisper";
  if (!reading && !whispering) return false;

  if (request.headers[CONTROL_HEADER] !== "1") {
    response.status(403).json({ ok: false, error: `Refused: ${request.method} ${request.path} needs the ${CONTROL_HEADER}: 1 header.` });
  } else if (deps.ring === null) {
    response.status(404).json({ ok: false, error: "Chat commands are off: this host was started without --chat-command-prefix." });
  } else if (reading) {
    readCommands(request, response, deps.ring);
  } else {
    void whisper(request, response, deps).catch((cause: unknown) => {
      if (response.headersSent) return;
      const reason = cause instanceof Error ? cause.message : String(cause);
      response.status(500).json({ ok: false, error: `The whisper did not complete (${reason}); the player can type the command again.` });
    });
  }
  return true;
}

function readCommands(request: Request, response: Response, ring: ChatCommandRing): void {
  const raw = request.query.after;
  if (raw !== undefined && (typeof raw !== "string" || !/^\d{1,15}$/u.test(raw))) {
    response.status(400).json({ ok: false, error: "after must be a non-negative integer (the seq of the last line you have)." });
    return;
  }
  response.status(200).json(ring.after(raw === undefined ? undefined : Number(raw)));
}

async function whisper(request: Request, response: Response, deps: ChatCommandRouteDeps): Promise<void> {
  const parsed = sendMessageInputSchema.safeParse(request.body);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
    response.status(400).json({ ok: false, error: reasons.join(" ") });
    return;
  }
  if (parsed.data.to === undefined) {
    response.status(400).json({ ok: false, error: "to: a whisper needs the player to answer." });
    return;
  }
  const sent = await deps.whisper(parsed.data.to, parsed.data.message);
  response.status(sent.ok ? 200 : 502).json(sent);
}
