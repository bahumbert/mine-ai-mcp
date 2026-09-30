import { z } from "zod";

export interface ChatTurn {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** A text-in, text-out model. One per tier: chat, action, planner (ADR-008). */
export interface ChatModel {
  readonly name: string;
  complete(turns: readonly ChatTurn[], signal: AbortSignal): Promise<string>;
}

export interface OpenAiCompatibleConfig {
  /** e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://127.0.0.1:11434/v1` (Ollama). */
  readonly baseUrl: string;
  /** Null for local servers that need none. Never logged. */
  readonly apiKey: string | null;
  readonly model: string;
  /** Ask for `response_format: json_object`; turn off for providers that reject it. */
  readonly jsonMode: boolean;
  readonly timeoutMs: number;
  /** Higher for lively dialogue, low for picking skills and planning. */
  readonly temperature: number;
}

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

/** Any server speaking the OpenAI `/chat/completions` API: OpenAI, OpenRouter, Groq, Mistral, Ollama, LM Studio... */
export class OpenAiCompatibleModel implements ChatModel {
  readonly name: string;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.name = config.model;
  }

  async complete(turns: readonly ChatTurn[], signal: AbortSignal): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey !== null) headers.authorization = `Bearer ${this.config.apiKey}`;
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: turns,
        temperature: this.config.temperature,
        ...(this.config.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
    });
    if (!response.ok) {
      throw new Error(`[LLM_HTTP_${response.status}] ${this.config.model}: ${(await response.text()).slice(0, 300)}`);
    }
    return completionSchema.parse(await response.json()).choices[0]?.message.content ?? "";
  }
}
