/** Install step `endpointTest`: one chat completion on the remote endpoint, with the parameters the brain sends. */
import { z } from "zod";
import { fetchErrorText } from "../fetch-error.ts";
import { failure, stepFailure, type InstallContext, type StepResult } from "./step.ts";

/** Plan: a slow provider has 30 s to answer one short completion. */
const ENDPOINT_TEST_TIMEOUT_MS = 30_000;
const TEST_PROMPT = 'Answer with a JSON object {"ok": true} and nothing else.';
/** The brain always sends a temperature (0.2 to 0.4 per tier, `brain/src/main.ts` TIER_TEMPERATURE): some reasoning models refuse any but 1. */
const TEST_TEMPERATURE = 0.2;
/** Request keys that are no optional parameter: a refusal naming one of them says nothing about a parameter. */
const REQUIRED_REQUEST_KEYS: ReadonlySet<string> = new Set(["model", "messages"]);

const completionSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1) });
const errorBodySchema = z.object({ error: z.union([z.string(), z.object({ message: z.string().optional(), param: z.string().nullish() })]) });

export interface EndpointDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The request body the brain sends (`brain/src/chat-model.ts` `request`): JSON mode and reasoning effort follow `brainEnv`. */
function completionRequestBody(model: string, brainEnv: Readonly<Record<string, string>>): Record<string, unknown> {
  const reasoningEffort = brainEnv.MINE_AI_LLM_REASONING_EFFORT;
  return {
    model,
    messages: [{ role: "user", content: TEST_PROMPT }],
    temperature: TEST_TEMPERATURE,
    ...(brainEnv.MINE_AI_LLM_JSON_MODE !== "false" ? { response_format: { type: "json_object" } } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}

/** The provider's own message and, when it names one, the offending parameter, from an OpenAI-style error body. */
function readErrorBody(text: string): { message: string; param?: string } {
  try {
    const { error } = errorBodySchema.parse(JSON.parse(text));
    if (typeof error === "string") return { message: error };
    return { message: error.message ?? text.slice(0, 200), ...(error.param ? { param: error.param } : {}) };
  } catch {
    return { message: text.slice(0, 200) };
  }
}

/** An optional request key the provider's message mentions: providers often refuse a parameter in words with `param` null. */
function parameterNamedIn(message: string, sentKeys: readonly string[]): string | undefined {
  return sentKeys.find((key) => !REQUIRED_REQUEST_KEYS.has(key) && message.toLowerCase().includes(key));
}

/** The failed step for a non-2xx answer: key refused, model not found, a parameter refused, or the bare status. */
function refusedStatus(status: number, text: string, baseUrl: string, model: string, sentKeys: readonly string[]): StepResult {
  const body = readErrorBody(text);
  const { message } = body;
  const param = body.param ?? (status === 400 ? parameterNamedIn(message, sentKeys) : undefined);
  if (status === 401 || status === 403) {
    return failure(`API key refused by ${baseUrl} (HTTP ${status}): ${message}`, "Check the key: copy it again from the provider, with no space around it.");
  }
  if (status === 404) {
    return failure(`Model not found: ${model} at ${baseUrl} (HTTP 404): ${message}`, "Check the model name, and that the URL is the API's base, such as https://api.example.com/v1.");
  }
  if (status === 400 && param !== undefined) {
    return failure(`The endpoint does not accept the parameter ${param} (HTTP 400): ${message}`, "The bots send this parameter on every call: pick a provider or a model that accepts it.");
  }
  if (status === 429) {
    return failure(`The endpoint is rate-limiting or out of quota (HTTP 429): ${message}`, "Check the provider's quota and billing, then test again.");
  }
  return failure(`The endpoint answered HTTP ${status}: ${message}`, "Check the URL, the model name and the key, then test again.");
}

/** Sends one completion to the remote endpoint of the settings; ok only when it answers with a completion. */
export async function endpointTest(ctx: InstallContext, deps: EndpointDeps = {}): Promise<StepResult> {
  const { llm } = ctx.settings;
  if (llm.kind !== "remote") {
    return failure("The settings do not use a remote endpoint.", "Run `mine-ai configure --llm-remote <url> <key> <model>` first, then test again.");
  }
  const baseUrl = llm.baseUrl.replace(/\/+$/u, "");
  const timeoutMs = deps.timeoutMs ?? ENDPOINT_TEST_TIMEOUT_MS;
  ctx.onProgress(0, "Testing the AI endpoint");
  try {
    const requestBody = completionRequestBody(llm.model, ctx.manifest.brainEnv);
    const response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(llm.apiKey === "" ? {} : { authorization: `Bearer ${llm.apiKey}` }) },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) return refusedStatus(response.status, text, baseUrl, llm.model, Object.keys(requestBody));
    completionSchema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return stepFailure(`The endpoint ${baseUrl} gave no answer within ${timeoutMs} ms.`, "Check the URL and the model name; a very slow model may need another provider.");
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return stepFailure(`${baseUrl} answered, but not with a chat completion.`, "The URL must be an OpenAI-compatible base, such as https://api.example.com/v1.");
    }
    return stepFailure(`Cannot reach ${baseUrl}: ${fetchErrorText(error)}`, "Check the URL and the internet connection.");
  }
  ctx.onProgress(1, "AI endpoint works");
  return { ok: true, detail: `${llm.model} answered at ${baseUrl}.` };
}
