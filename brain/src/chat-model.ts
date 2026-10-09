import { z } from "zod";

export interface ChatTurn {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** One answer, with what the server said about its size: a prompt close to the context window is cut silently. */
export interface ChatReply {
  readonly text: string;
  /** Tokens the server read from the prompt (`usage.prompt_tokens`); null when it does not say. */
  readonly promptTokens: number | null;
  /** The context window the model ran with: configured, or read from Ollama; null when unknown. */
  readonly contextTokens: number | null;
}

/** A text-in, text-out model. One per tier: chat, action, planner (ADR-008). */
export interface ChatModel {
  readonly name: string;
  complete(turns: readonly ChatTurn[], signal: AbortSignal): Promise<ChatReply>;
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
  /**
   * The model's context window in tokens, when known. Null: asked from Ollama's `/api/ps` (the window the model was
   * loaded with, `OLLAMA_CONTEXT_LENGTH`), since Ollama's OpenAI API cannot set it and cuts a longer prompt silently.
   */
  readonly contextTokens: number | null;
}

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative() }).partial().nullish(),
});

const ollamaRunningSchema = z.object({
  models: z.array(z.object({ name: z.string(), model: z.string().optional(), context_length: z.number().int().positive().optional() })),
});

/** Any server speaking the OpenAI `/chat/completions` API: OpenAI, OpenRouter, Groq, Mistral, Ollama, LM Studio... */
export class OpenAiCompatibleModel implements ChatModel {
  readonly name: string;
  private contextTokens: number | null;
  private contextAsked = false;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.name = config.model;
    this.contextTokens = config.contextTokens;
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/u, "");
  }

  async complete(turns: readonly ChatTurn[], signal: AbortSignal): Promise<ChatReply> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey !== null) headers.authorization = `Bearer ${this.config.apiKey}`;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
    const completion = completionSchema.parse(await response.json());
    if (!this.contextAsked) {
      this.contextAsked = true;
      this.contextTokens ??= await this.askOllamaContext(signal);
    }
    return {
      text: completion.choices[0]?.message.content ?? "",
      promptTokens: completion.usage?.prompt_tokens ?? null,
      contextTokens: this.contextTokens,
    };
  }

  /** The window Ollama loaded this model with (asked once, after a first answer so the model is loaded); null elsewhere. */
  private async askOllamaContext(signal: AbortSignal): Promise<number | null> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/v1$/u, "")}/api/ps`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
      if (!response.ok) return null;
      const running = ollamaRunningSchema.parse(await response.json());
      return running.models.find((model) => model.name === this.config.model || model.model === this.config.model)?.context_length ?? null;
    } catch {
      return null;
    }
  }
}
