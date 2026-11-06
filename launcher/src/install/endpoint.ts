/** Install step `endpointTest`: one chat completion on the remote endpoint, with the parameters the brain sends. */
import { z } from "zod";
import { fetchErrorText } from "../fetch-error.ts";
import { clearKeyMigrationLine, saveSettings, type Settings, type SettingsOptions } from "../settings.ts";
import { failure, stepFailure, type InputCorrection, type InstallContext, type StepFailure, type StepResult } from "./step.ts";

/** Plan: a slow provider has 30 s to answer one short completion. */
const ENDPOINT_TEST_TIMEOUT_MS = 30_000;
const TEST_PROMPT = 'Answer with a JSON object {"ok": true} and nothing else.';
/** The brain always sends a temperature (0.2 to 0.4 per tier, `brain/src/main.ts` TIER_TEMPERATURE): some reasoning models refuse any but 1. */
const TEST_TEMPERATURE = 0.2;
/** Request keys that are no optional parameter: a refusal naming one of them says nothing about a parameter. */
export const REQUIRED_REQUEST_KEYS: ReadonlySet<string> = new Set(["model", "messages"]);

const completionSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1) });
const errorBodySchema = z.object({ error: z.union([z.string(), z.object({ message: z.string().optional(), param: z.string().nullish() })]) });

export interface EndpointDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** How a corrected URL is saved (tests give a fake cipher); the real ones by default. */
  readonly settingsOptions?: SettingsOptions;
}

/** The request body the brain sends (`brain/src/chat-model.ts` `request`): JSON mode and reasoning effort follow `brainEnv`. */
export function completionRequestBody(model: string, brainEnv: Readonly<Record<string, string>>): Record<string, unknown> {
  const reasoningEffort = brainEnv.MINE_AI_LLM_REASONING_EFFORT;
  return {
    model,
    messages: [{ role: "user", content: TEST_PROMPT }],
    temperature: TEST_TEMPERATURE,
    ...(brainEnv.MINE_AI_LLM_JSON_MODE !== "false" ? { response_format: { type: "json_object" } } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}

/** `Authorization: Bearer <key>` for a non-empty key, no header for an empty one (as the brain does). */
export const bearerHeader = (apiKey: string): Record<string, string> => (apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` });

/** Why a step that needs the saved key stops: it was encrypted for another Windows user or PC (`secret.ts` `keyUnreadable`). The setup shows this text, so it never sends the player to the setup. */
export function savedKeyUnreadable(): StepFailure {
  return failure("The saved API key was saved by another Windows user or on another PC and cannot be read here.", "Type the key again (silent install: /LLMKEY=).");
}

// ---------------------------------------------------------------------------------------------------------------------
// The /v1 correction (spec D4(a))

/** One answer of `withV1Retry`: the response with its body read, and which base URL answered. */
export interface V1Answer {
  readonly response: Response;
  /** The body, read whole. */
  readonly text: string;
  /** The URL asked first, without trailing slashes. */
  readonly askedBase: string;
  /** The base the answer came from: `askedBase`, or `askedBase/v1` when `corrected`. */
  readonly base: string;
  /** `<askedBase>/v1` answered like an OpenAI-compatible API where `askedBase` answered 404: it is the right base. */
  readonly corrected: boolean;
  /** A retry on `/v1` was sent and did not answer as an OpenAI-compatible API (or failed): the first 404 stands. */
  readonly v1Refused: boolean;
}

/** True when the last path segment of the URL is `v1`, whatever its case. */
function endsInV1(base: string): boolean {
  try {
    return new URL(base).pathname.split("/").filter(Boolean).at(-1)?.toLowerCase() === "v1";
  } catch {
    return false;
  }
}

const openAiShapeSchema = z.union([
  z.object({ choices: z.array(z.unknown()) }),
  z.object({ data: z.array(z.unknown()).nullable() }), // Ollama answers `data: null` for an empty model store (measured 2026-11-06)
  z.object({ error: z.object({ message: z.string() }) }), // an error object, not a bare string: a generic API's `{"error":"Not Found"}` proves nothing
]);

/** True for a JSON body an OpenAI-compatible API sends: a completion (`choices`), a list (`data`) or an error object (`error.message`). */
function isOpenAiShaped(text: string): boolean {
  try {
    return openAiShapeSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

async function sendAndRead(send: (url: string) => Promise<Response>, url: string): Promise<{ response: Response; text: string }> {
  const response = await send(url);
  return { response, text: await response.text() };
}

/**
 * Sends `path` to `base`; an answer 404 from a base that does not end in `/v1` is asked once more at `<base>/v1<path>`
 * (a player types `http://pc:11434` for Ollama, whose API lives under `/v1`). `<base>/v1` becomes the base only when its
 * answer is OpenAI-shaped, whatever its status: a gateway that answers HTML 401 to every path proves nothing. A retry that
 * throws leaves the first answer. A first request that throws throws.
 */
export async function withV1Retry(base: string, path: string, send: (url: string) => Promise<Response>): Promise<V1Answer> {
  const askedBase = base.replace(/\/+$/u, "");
  const first = await sendAndRead(send, `${askedBase}${path}`);
  const unchanged = { ...first, askedBase, base: askedBase, corrected: false };
  if (first.response.status !== 404 || endsInV1(askedBase)) return { ...unchanged, v1Refused: false };
  const v1Base = `${askedBase}/v1`;
  try {
    const retry = await sendAndRead(send, `${v1Base}${path}`);
    if (isOpenAiShaped(retry.text)) return { ...retry, askedBase, base: v1Base, corrected: true, v1Refused: false };
  } catch {
    // the retry failed on the wire or timed out: the first 404 is the answer to report
  }
  return { ...unchanged, v1Refused: true };
}

/** The sentence that tells the player the URL was changed (owner rule: an automatic correction is always told). */
export const urlCorrectionNotice = (from: string, to: string): string =>
  `The endpoint URL was changed from ${from} to ${to}: ${from} answered 404 (not found) and ${to} answers as an OpenAI-compatible API.`;

/** The hint's addition when the `/v1` retry was tried and refused. */
export const v1RefusedHint = (askedBase: string): string => `(${askedBase}/v1 did not answer as an OpenAI-compatible API either)`;

/** What a step reports about a corrected URL: the fields of `InputCorrection` and the sentence. */
export function correctionOf(answer: V1Answer): Required<InputCorrection> | null {
  return answer.corrected ? { correctedUrl: answer.base, notice: urlCorrectionNotice(answer.askedBase, answer.base) } : null;
}

/** `result` with the correction told: its text starts with the notice (and `extra` sentences), the fields carry the new URL. */
export function withCorrectionTold(result: StepResult, correction: Required<InputCorrection> | null, extra: readonly string[] = []): StepResult {
  if (correction === null) return result;
  const told = [correction.notice, ...extra].join(" ");
  return result.ok ? { ...result, ...correction, detail: `${told} ${result.detail}` } : { ...result, ...correction, error: `${told} ${result.error}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// The test itself

/** The provider's own message and, when it names one, the offending parameter, from a JSON error body; null for any other body. */
export function parseJsonErrorBody(text: string): { message: string; param?: string } | null {
  try {
    const { error } = errorBodySchema.parse(JSON.parse(text));
    if (typeof error === "string") return { message: error };
    return { message: error.message ?? text.slice(0, 200), ...(error.param ? { param: error.param } : {}) };
  } catch {
    return null;
  }
}

/** `parseJsonErrorBody`, or the start of whatever the body is. */
function readErrorBody(text: string): { message: string; param?: string } {
  return parseJsonErrorBody(text) ?? { message: text.slice(0, 200) };
}

/** An optional request key the provider's message mentions: providers often refuse a parameter in words with `param` null. */
function parameterNamedIn(message: string, sentKeys: readonly string[]): string | undefined {
  return sentKeys.find((key) => !REQUIRED_REQUEST_KEYS.has(key) && message.toLowerCase().includes(key));
}

/** The failed step for a non-2xx answer: key refused, model not found, a parameter refused, or the bare status. */
function refusedStatus(status: number, text: string, baseUrl: string, model: string, sentKeys: readonly string[]): StepFailure {
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

/** The step's verdict on an answer that reached us. */
function judgeAnswer(answer: V1Answer, model: string, sentKeys: readonly string[]): StepResult {
  const { response, text, base } = answer;
  if (!response.ok) {
    const refused = refusedStatus(response.status, text, base, model, sentKeys);
    return answer.v1Refused ? { ...refused, hint: `${refused.hint} ${v1RefusedHint(answer.askedBase)}` } : refused;
  }
  try {
    completionSchema.parse(JSON.parse(text));
  } catch {
    return stepFailure(`${base} answered, but not with a chat completion.`, "The URL must be an OpenAI-compatible base, such as https://api.example.com/v1.");
  }
  return { ok: true, detail: `${model} answered at ${base}.` };
}

/** The failed step for a request that threw: no answer in time, or no connection. */
function unansweredRequest(error: unknown, baseUrl: string, timeoutMs: number): StepFailure {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return failure(`The endpoint ${baseUrl} gave no answer within ${timeoutMs} ms.`, "Check the URL and the model name; a very slow model may need another provider.");
  }
  return failure(`Cannot reach ${baseUrl}: ${fetchErrorText(error)}`, "Check the URL and the internet connection.");
}

/**
 * Saves the corrected URL (the key stays as loaded: `saveSettings` keeps the blob). Returns the sentences to add to the
 * result: the key migration, when this save encrypted a clear key; or the failure when the file cannot be written.
 */
function saveCorrectedUrl(ctx: InstallContext, llm: Extract<Settings["llm"], { kind: "remote" }>, correctedUrl: string, options: SettingsOptions | undefined): string[] | Error {
  const migration = clearKeyMigrationLine(ctx.root, ctx.settings);
  try {
    saveSettings(ctx.root, { ...ctx.settings, llm: { ...llm, baseUrl: correctedUrl } }, options);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return migration === null ? [] : [migration];
}

/** Sends one completion to the remote endpoint of the settings; ok only when it answers with a completion. */
export async function endpointTest(ctx: InstallContext, deps: EndpointDeps = {}): Promise<StepResult> {
  const { llm } = ctx.settings;
  if (llm.kind !== "remote") {
    return failure("The settings do not use a remote endpoint.", "Run `mine-ai configure --llm-remote <url> <key> <model>` first, then test again.");
  }
  if (llm.keyUnreadable === true) return savedKeyUnreadable();
  const timeoutMs = deps.timeoutMs ?? ENDPOINT_TEST_TIMEOUT_MS;
  const requestBody = completionRequestBody(llm.model, ctx.manifest.brainEnv);
  const post = (url: string): Promise<Response> =>
    (deps.fetchImpl ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json", ...bearerHeader(llm.apiKey) }, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(timeoutMs) });
  ctx.onProgress(0, "Testing the AI endpoint");
  let answer: V1Answer;
  try {
    answer = await withV1Retry(llm.baseUrl, "/chat/completions", post);
  } catch (error) {
    return unansweredRequest(error, llm.baseUrl.replace(/\/+$/u, ""), timeoutMs);
  }
  const correction = correctionOf(answer);
  const saved = correction === null ? [] : saveCorrectedUrl(ctx, llm, correction.correctedUrl, deps.settingsOptions);
  if (saved instanceof Error) {
    return withCorrectionTold(failure(`The corrected URL ${answer.base} could not be saved: ${saved.message}`, `Run \`mine-ai configure --llm-remote ${answer.base} <key> <model>\` to save it, then test again.`), correction);
  }
  const verdict = judgeAnswer(answer, llm.model, Object.keys(requestBody));
  if (verdict.ok) ctx.onProgress(1, "AI endpoint works");
  return withCorrectionTold(verdict, correction, saved);
}
