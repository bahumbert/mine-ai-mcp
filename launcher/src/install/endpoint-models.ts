/**
 * Install step `endpointModels`: the models a remote endpoint lists (`GET <base>/models`), written for the installer's
 * model box. One request per call, no text generated, so it costs nothing (spec D4(b)).
 */
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { fetchErrorText } from "../fetch-error.ts";
import { ensureParentDir } from "../paths.ts";
import type { Settings } from "../settings.ts";
import { bearerHeader, completionRequestBody, correctionOf, parseJsonErrorBody, REQUIRED_REQUEST_KEYS, savedKeyUnreadable, v1RefusedHint, withCorrectionTold, withV1Retry, type EndpointDeps, type V1Answer } from "./endpoint.ts";
import { failure, type InstallContext, type StepFailure, type StepResult } from "./step.ts";

/** A listing is one small GET: 15 s is plenty for a provider that answers at all (OpenRouter's 453 models: 0.11 s, measured 2026-11-06). */
const MODEL_LIST_TIMEOUT_MS = 15_000;
/** The longest piece of a provider's error text shown in a reason. */
const REASON_TEXT_CHARS = 120;
/** A line of the list file is `<id>\t<info>`: an id with one of these would break it. */
const LINE_BREAKING_CHARS = /[\t\r\n]/u;

export interface EndpointModelsOptions {
  /** The endpoint to list; the settings' URL when absent. */
  readonly url?: string;
  /** The key to send; with `savedKey` and `url` absent the settings' key is used, else none. */
  readonly key?: string;
  /** Use the key of the settings (the setup never has it in clear). */
  readonly savedKey: boolean;
  /** Where the list is written, on success only. */
  readonly listFile: string;
}

/** An optional number: absent or not a number is `undefined`, never an error for the entry. */
const optionalNumber = z.number().optional().catch(undefined);
/** A price in dollars per token: OpenRouter sends a string such as `"0.0000015"`; a bad value is `undefined`. */
const optionalPrice = z.union([z.string().min(1), z.number()]).pipe(z.coerce.number()).optional().catch(undefined);
/** The fields of one entry the list reads; every optional one that is malformed counts as absent. */
const modelEntrySchema = z.looseObject({
  id: z.string().min(1),
  context_length: optionalNumber,
  architecture: z.looseObject({ output_modalities: z.array(z.string()).optional().catch(undefined) }).optional().catch(undefined),
  pricing: z.looseObject({ prompt: optionalPrice, completion: optionalPrice }).optional().catch(undefined),
  supported_parameters: z.array(z.string()).optional().catch(undefined),
});
type ModelEntry = z.infer<typeof modelEntrySchema>;
/** Ollama answers `data: null` for an empty store (measured 2026-11-06), so a null list is an empty one. */
const listBodySchema = z.object({ data: z.array(z.unknown()).nullable() });

const priceFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3, useGrouping: false });

/** `$1.5 / $6 per million tokens in / out`, `free`, or `price varies` (OpenRouter's routers give `-1`); null when an entry gives no pair of prices. */
function priceInfo(pricing: ModelEntry["pricing"]): string | null {
  const prompt = pricing?.prompt;
  const completion = pricing?.completion;
  if (prompt === undefined || completion === undefined) return null;
  if (prompt < 0 || completion < 0) return "price varies";
  if (prompt === 0 && completion === 0) return "free";
  const perMillion = (perToken: number): string => `$${priceFormat.format(perToken * 1_000_000)}`;
  return `${perMillion(prompt)} / ${perMillion(completion)} per million tokens in / out`;
}

/** What the entry says about itself, only from the fields it has: context size, price, and the parameters the brain sends that it does not list. */
function modelInfo(entry: ModelEntry, brainParameters: readonly string[]): string {
  const context = entry.context_length !== undefined && entry.context_length >= 500 ? `${Math.round(entry.context_length / 1000)}k context` : null;
  const listed = entry.supported_parameters;
  const missing = listed === undefined ? [] : brainParameters.filter((parameter) => !listed.includes(parameter)).map((parameter) => `does not list ${parameter}`);
  return [context, priceInfo(entry.pricing), ...missing].filter((part): part is string => part !== null).join(", ");
}

/** The bots need text out: an entry that names its output modalities without `text` is left out. */
const isTextModel = (entry: ModelEntry): boolean => entry.architecture?.output_modalities?.includes("text") ?? true;

/** The failed step for an endpoint that gives no usable list: the reason, then the way out (the model box stays free text). */
function noModelList(reason: string, extraHint = ""): StepFailure {
  return failure(`The endpoint gives no model list (${reason}).`, `Type the model name.${extraHint === "" ? "" : ` ${extraHint}`}`);
}

/** The URL and key to list with, from the options and the settings, or the failure when the saved key is not available. */
function listingSource(llm: Settings["llm"], options: EndpointModelsOptions): { baseUrl: string; apiKey: string } | StepFailure {
  const saved = llm.kind === "remote" ? llm : null;
  const baseUrl = options.url ?? saved?.baseUrl;
  if (baseUrl === undefined) {
    return failure("The settings do not use a remote endpoint and no URL was given.", "Give the endpoint's address with --url <url>, or run `mine-ai configure --llm-remote <url> <key> <model>` first.");
  }
  if (options.key !== undefined) return { baseUrl, apiKey: options.key };
  if (!options.savedKey && options.url !== undefined) return { baseUrl, apiKey: "" };
  if (saved === null) return failure("There is no saved API key: the settings do not use a remote endpoint.", "Type the key (--key <key>); leave it out for an endpoint that needs none.");
  return saved.keyUnreadable === true ? savedKeyUnreadable() : { baseUrl, apiKey: saved.apiKey };
}

/** The lines of the list file for an answer, or why the endpoint gives no usable list. */
function modelLines(answer: V1Answer, brainEnv: Readonly<Record<string, string>>): string[] | StepFailure {
  const { response, text } = answer;
  const refusedHint = answer.v1Refused ? v1RefusedHint(answer.askedBase) : "";
  if (!response.ok) {
    const message = (parseJsonErrorBody(text)?.message ?? "").replace(/\s+/gu, " ").trim().slice(0, REASON_TEXT_CHARS);
    return noModelList(`HTTP ${response.status}${message === "" ? "" : `: ${message}`}`, refusedHint);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return noModelList("the answer is not JSON", refusedHint);
  }
  const body = listBodySchema.safeParse(json);
  if (!body.success) return noModelList("the answer has no model list", refusedHint);
  const entries = body.data.data?.flatMap((raw) => { const entry = modelEntrySchema.safeParse(raw); return entry.success ? [entry.data] : []; }) ?? [];
  if (body.data.data !== null && body.data.data.length > 0 && entries.length === 0) return noModelList("the answer holds no model ids", refusedHint);
  const brainParameters = Object.keys(completionRequestBody("", brainEnv)).filter((key) => !REQUIRED_REQUEST_KEYS.has(key));
  const lines = new Map<string, string>();
  for (const entry of entries) if (isTextModel(entry) && !LINE_BREAKING_CHARS.test(entry.id) && !lines.has(entry.id)) lines.set(entry.id, `${entry.id}\t${modelInfo(entry, brainParameters)}`);
  if (lines.size === 0) return failure("The endpoint lists no text model.", "Type the model name, or add a model on the endpoint first.");
  return [...lines.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, line]) => line);
}

/** The failed step for a listing request that threw: no answer in time, or no connection. */
function unansweredListing(error: unknown, baseUrl: string, timeoutMs: number): StepFailure {
  if (error instanceof DOMException && error.name === "TimeoutError") return noModelList(`no answer within ${timeoutMs} ms`);
  return noModelList(`Cannot reach ${baseUrl}: ${fetchErrorText(error)}`);
}

/**
 * Lists the models of the endpoint into `options.listFile` (UTF-8, `<id>\t<info>` per line, sorted by id). Writes no
 * settings: a corrected URL is returned and told, and the installer saves it with the rest. The file is written on
 * success only.
 */
export async function endpointModels(ctx: InstallContext, options: EndpointModelsOptions, deps: Pick<EndpointDeps, "fetchImpl" | "timeoutMs"> = {}): Promise<StepResult> {
  const source = listingSource(ctx.settings.llm, options);
  if ("ok" in source) return source;
  const timeoutMs = deps.timeoutMs ?? MODEL_LIST_TIMEOUT_MS;
  const get = (url: string): Promise<Response> => (deps.fetchImpl ?? fetch)(url, { headers: bearerHeader(source.apiKey), signal: AbortSignal.timeout(timeoutMs) });
  ctx.onProgress(0, "Reading the endpoint's model list");
  let answer: V1Answer;
  try {
    answer = await withV1Retry(source.baseUrl, "/models", get);
  } catch (error) {
    return unansweredListing(error, source.baseUrl.replace(/\/+$/u, ""), timeoutMs);
  }
  // With --url (the setup's path) the setup changes its URL box; without it the URL is the saved one and this step saves nothing.
  const correction = correctionOf(answer, options.url !== undefined);
  const lines = modelLines(answer, ctx.manifest.brainEnv);
  if (!Array.isArray(lines)) return withCorrectionTold(lines, correction);
  try {
    ensureParentDir(options.listFile);
    writeFileSync(options.listFile, `${lines.join("\n")}\n`, "utf8");
  } catch (error) {
    return withCorrectionTold(failure(`The model list could not be written to ${options.listFile}: ${error instanceof Error ? error.message : String(error)}`, "Type the model name."), correction);
  }
  ctx.onProgress(1, "Models listed");
  return withCorrectionTold({ ok: true, detail: `${lines.length} ${lines.length === 1 ? "model" : "models"} listed.` }, correction);
}
