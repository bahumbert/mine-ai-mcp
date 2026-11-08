import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { monotonicNow } from "../clocks.ts";
import { fakeKeyCipher } from "../key-cipher-test-support.ts";
import { loadManifest } from "../manifest.ts";
import { loadSettings, settingsPath, type Settings, type SettingsOptions } from "../settings.ts";
import { endpointTest } from "./endpoint.ts";
import { answerJson as answer, answerText, fakeEndpoint, remoteContext, withFakeEndpoint as withEndpoint, type Handler } from "./fixtures/fake-endpoint.ts";
import type { InstallContext } from "./step.ts";

const completion = answer(200, { choices: [{ message: { content: '{"ok":true}' } }] });

function context(baseUrl: string, options: { brainEnv?: Record<string, string>; apiKey?: string } = {}): InstallContext {
  const manifest = loadManifest();
  return {
    manifest: options.brainEnv === undefined ? manifest : { ...manifest, brainEnv: options.brainEnv },
    settings: { llm: { kind: "remote", baseUrl, apiKey: options.apiKey ?? "sk-test", model: "big-model" } } as Settings,
    root: "unused",
    onProgress: () => {},
  };
}

test("one chat completion with the brain's parameters ends ok, a trailing slash on the base URL included", async () => {
  await withEndpoint(completion, async (endpoint) => {
    const result = await endpointTest(context(`${endpoint.baseUrl}/`));
    assert.equal(result.ok, true);
    assert.equal(endpoint.seen.length, 1);
    const [request] = endpoint.seen;
    assert.equal(request!.url, "/v1/chat/completions");
    assert.equal(request!.authorization, "Bearer sk-test");
    assert.equal(request!.body.model, "big-model");
    assert.equal(typeof request!.body.temperature, "number");
    assert.deepEqual(request!.body.response_format, { type: "json_object" });
    assert.equal(request!.body.reasoning_effort, "none");
    assert.match(JSON.stringify(request!.body.messages), /json/iu);
  });
});

test("an endpoint that refuses the temperature the brain sends (reasoning models) fails the test, naming it", async () => {
  const reasoningModel: Handler = (response, body) => {
    if (body.temperature !== undefined && body.temperature !== 1) answer(400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model.", param: "temperature" } })(response, body);
    else completion(response, body);
  };
  await withEndpoint(reasoningModel, async (endpoint) => {
    const result = await endpointTest(context(endpoint.baseUrl));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /temperature/u);
  });
});

test("JSON mode off and an empty reasoning effort in brainEnv send neither parameter; JSON mode not set is on, as in the brain", async () => {
  await withEndpoint(completion, async (endpoint) => {
    await endpointTest(context(endpoint.baseUrl, { brainEnv: { MINE_AI_LLM_JSON_MODE: "false", MINE_AI_LLM_REASONING_EFFORT: "" } }));
    assert.equal("response_format" in endpoint.seen[0]!.body, false);
    assert.equal("reasoning_effort" in endpoint.seen[0]!.body, false);
    await endpointTest(context(endpoint.baseUrl, { brainEnv: {} }));
    assert.deepEqual(endpoint.seen[1]!.body.response_format, { type: "json_object" });
  });
});

test("an empty key sends no authorization header, as the brain does", async () => {
  await withEndpoint(completion, async (endpoint) => {
    await endpointTest(context(endpoint.baseUrl, { apiKey: "" }));
    assert.equal(endpoint.seen[0]!.authorization, undefined);
  });
});

test("401 is 'key refused'", async () => {
  await withEndpoint(answer(401, { error: { message: "Incorrect API key provided" } }), async (endpoint) => {
    const result = await endpointTest(context(endpoint.baseUrl));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /key refused/iu);
      assert.match(result.hint, /key/u);
    }
  });
});

test("404 is 'model not found' and names the model", async () => {
  await withEndpoint(answer(404, { error: { message: "The model `big-model` does not exist" } }), async (endpoint) => {
    const result = await endpointTest(context(endpoint.baseUrl));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /model not found/iu);
      assert.match(result.error, /big-model/u);
    }
  });
});

test("a 400 naming a parameter reports that parameter", async () => {
  const refusal = answer(400, { error: { message: "Unsupported parameter: 'reasoning_effort'", param: "reasoning_effort", type: "invalid_request_error" } });
  await withEndpoint(refusal, async (endpoint) => {
    const result = await endpointTest(context(endpoint.baseUrl));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /reasoning_effort/u);
      assert.match(result.hint, /provider|model/u);
    }
  });
});

test("a 400 whose message names a parameter we sent, with param null, still reports that parameter", async () => {
  const refusal = answer(400, { error: { message: "Unrecognized request argument supplied: response_format", param: null } });
  await withEndpoint(refusal, async (endpoint) => {
    const result = await endpointTest(context(endpoint.baseUrl));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /parameter response_format/u);
      assert.match(result.hint, /provider|model/u);
    }
  });
});

for (const { status, message } of [
  { status: 400, message: "Invalid model id format" },
  { status: 503, message: "overloaded" },
  { status: 429, message: "You exceeded your current quota" },
]) {
  test(`HTTP ${status} reports its code and the server's message`, async () => {
    await withEndpoint(answer(status, { error: { message } }), async (endpoint) => {
      const result = await endpointTest(context(endpoint.baseUrl));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, new RegExp(`${status}.*${message}`, "su"));
        assert.ok(result.hint.length > 0);
      }
    });
  });
}

test("an answer without a completion is an error, not a pass", async () => {
  await withEndpoint(answer(200, { hello: "world" }), async (endpoint) => {
    const result = await endpointTest(context(endpoint.baseUrl));
    assert.equal(result.ok, false);
  });
});

test("an endpoint that never answers fails after the timeout, naming it", async () => {
  await withEndpoint(() => {}, async (endpoint) => {
    const started = monotonicNow();
    const result = await endpointTest(context(endpoint.baseUrl), { timeoutMs: 300 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /300 ms/u);
    assert.ok(monotonicNow() - started < 3_000);
  });
});

test("a closed port says the endpoint cannot be reached", async () => {
  const endpoint = await fakeEndpoint(completion);
  const { baseUrl } = endpoint;
  endpoint.close();
  const result = await endpointTest(context(baseUrl));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /cannot reach/iu);
});

test("a connection Bun cut shows the cause without Bun's 'pass verbose: true' hint", async () => {
  const cut = (async () => {
    throw new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
  }) as unknown as typeof fetch;
  const result = await endpointTest(context("http://127.0.0.1:1/v1"), { fetchImpl: cut });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "Cannot reach http://127.0.0.1:1/v1: The socket connection was closed unexpectedly.");
});

test("settings without a remote endpoint fail with the configure command", async () => {
  const ctx = { ...context("http://127.0.0.1:1/v1"), settings: { llm: { kind: "local", model: "gemma4:12b" } } as Settings };
  const result = await endpointTest(ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.hint, /configure --llm-remote/u);
});

// --- the /v1 correction (spec D4(a)) and the unreadable saved key (spec D3) ---------------------------------------------

const WINDOWS_KEYS: SettingsOptions = { platform: "win32", cipher: fakeKeyCipher() };
/** Ollama's root: no such path (`404 page not found`, text/plain; measured 2026-11-06, facts packaging.md). */
const rootHasNothing = answerText(404, "404 page not found");
/** Ollama on the root URL: only `/v1/...` answers, with `v1`; anything else is the root's plain 404. */
const answersOnlyUnderV1 = (v1: Handler): Handler => (response, body, seen) => (seen.url.startsWith("/v1/") ? v1 : rootHasNothing)(response, body, seen);
/** What Ollama answers on `/v1/chat/completions` for a model it does not have (measured 2026-11-06, Ollama 0.35.0). */
const ollamaModelNotFound = answer(404, { error: { message: "model 'big-model' not found", type: "not_found_error", param: null, code: null } });
const savedLlm = (root: string): Record<string, unknown> => (JSON.parse(readFileSync(settingsPath(root), "utf8")) as { llm: Record<string, unknown> }).llm;
const correctionNotice = (from: string, to: string): string => `The endpoint URL was changed from ${from} to ${to}: ${from} answered 404 (not found) and ${to} answers as an OpenAI-compatible API.`;

test("a URL without /v1 (a trailing slash trimmed first) that answers 404 while /v1 answers is corrected: saved with the key still encrypted, returned and told; the next run goes to /v1 at once", async () => {
  await withEndpoint(answersOnlyUnderV1(completion), async (endpoint) => {
    const ctx = remoteContext({ baseUrl: `${endpoint.rootUrl}/` });
    const result = await endpointTest(ctx, { settingsOptions: WINDOWS_KEYS });
    assert.equal(result.ok, true);
    assert.deepEqual(endpoint.seen.map((request) => request.url), ["/chat/completions", "/v1/chat/completions"]);
    const notice = correctionNotice(endpoint.rootUrl, endpoint.baseUrl);
    assert.equal(result.correctedUrl, endpoint.baseUrl);
    assert.equal(result.notice, notice);
    if (result.ok) assert.ok(result.detail.startsWith(notice), result.detail);
    const saved = savedLlm(ctx.root);
    assert.equal(saved.baseUrl, endpoint.baseUrl);
    assert.equal("apiKey" in saved, false);
    assert.equal(typeof saved.apiKeyProtected, "string");
    assert.ok(!readFileSync(settingsPath(ctx.root), "utf8").includes("sk-test"));
    endpoint.seen.length = 0;
    const again = await endpointTest({ ...ctx, settings: loadSettings(ctx.root, ctx.manifest, WINDOWS_KEYS) }, { settingsOptions: WINDOWS_KEYS });
    assert.equal(again.ok, true);
    assert.deepEqual(endpoint.seen.map((request) => request.url), ["/v1/chat/completions"]);
    assert.equal(again.correctedUrl, undefined);
    assert.equal(again.notice, undefined);
  });
});

test("a URL already ending in /v1 (any case) that answers 404 is not retried: model not found as before", async () => {
  await withEndpoint(ollamaModelNotFound, async (endpoint) => {
    for (const base of [endpoint.baseUrl, endpoint.baseUrl.replace("/v1", "/V1")]) {
      endpoint.seen.length = 0;
      const result = await endpointTest(remoteContext({ baseUrl: base }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /model not found/iu);
      assert.equal(endpoint.seen.length, 1);
    }
  });
});

for (const [label, v1Answer, failure] of [
  ["Ollama's 404 JSON for a missing model", ollamaModelNotFound, /Model not found: big-model/u],
  ["a JSON 401", answer(401, { error: { message: "Incorrect API key provided" } }), /key refused/iu],
] as const) {
  test(`root 404 and /v1 answering ${label}: URL corrected and saved, told, and the failure is the one /v1 gave`, async () => {
    await withEndpoint(answersOnlyUnderV1(v1Answer), async (endpoint) => {
      const ctx = remoteContext({ baseUrl: endpoint.rootUrl });
      const result = await endpointTest(ctx);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.ok(result.error.startsWith(correctionNotice(endpoint.rootUrl, endpoint.baseUrl)), result.error);
      assert.match(result.error, failure);
      assert.equal(result.correctedUrl, endpoint.baseUrl);
      assert.equal(savedLlm(ctx.root).baseUrl, endpoint.baseUrl);
    });
  });
}

for (const [label, handler] of [
  ["an HTML 401 on /v1 (a gateway)", answersOnlyUnderV1(answerText(401, "<html>Sign in</html>", "text/html"))],
  ["JSON {\"error\": \"Not Found\"} on every path (an error string, no OpenAI error object)", answer(404, { error: "Not Found" })],
] as const) {
  test(`root 404 and ${label}: not corrected, nothing saved, the hint says /v1 did not answer as OpenAI`, async () => {
    await withEndpoint(handler, async (endpoint) => {
      const ctx = remoteContext({ baseUrl: endpoint.rootUrl });
      const result = await endpointTest(ctx);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, new RegExp(`Model not found: big-model at ${endpoint.rootUrl}`, "u"));
      assert.ok(result.hint.includes(`(${endpoint.baseUrl} did not answer as an OpenAI-compatible API either)`), result.hint);
      assert.equal(result.correctedUrl, undefined);
      assert.deepEqual(endpoint.seen.map((request) => request.url), ["/chat/completions", "/v1/chat/completions"]);
      assert.equal(existsSync(settingsPath(ctx.root)), false);
    });
  });
}

test("root 404 and a /v1 request that fails on the wire: today's 404 failure, nothing saved", async () => {
  const cutOnV1: Handler = (response, body, seen) => (seen.url.startsWith("/v1/") ? void response.socket?.destroy() : rootHasNothing(response, body, seen));
  await withEndpoint(cutOnV1, async (endpoint) => {
    const ctx = remoteContext({ baseUrl: endpoint.rootUrl });
    const result = await endpointTest(ctx);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Model not found: big-model/u);
    assert.equal(existsSync(settingsPath(ctx.root)), false);
  });
});

test("a corrected URL saved over a key that was clear in the file also says the key is now encrypted", async () => {
  await withEndpoint(answersOnlyUnderV1(completion), async (endpoint) => {
    const result = await endpointTest(remoteContext({ baseUrl: endpoint.rootUrl, clearKeyInFile: true }), { settingsOptions: WINDOWS_KEYS });
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.detail, /API key in .*settings\.json is now encrypted/u);
  });
});

test("a corrected URL that cannot be saved is a failure that says so and still returns the corrected URL", async () => {
  await withEndpoint(answersOnlyUnderV1(completion), async (endpoint) => {
    const ctx = remoteContext({ baseUrl: endpoint.rootUrl });
    const notAFolder = join(ctx.root, "file");
    writeFileSync(notAFolder, "x");
    const result = await endpointTest({ ...ctx, root: notAFolder });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /could not be saved/u);
    assert.equal(result.correctedUrl, endpoint.baseUrl);
  });
});

test("a saved key that cannot be read here fails at once, with no request and with the setup-facing text", async () => {
  await withEndpoint(completion, async (endpoint) => {
    const result = await endpointTest(remoteContext({ baseUrl: endpoint.baseUrl, apiKey: "", apiKeyProtected: "QUJD", keyUnreadable: true }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "The saved API key was saved by another Windows user or on another PC and cannot be read here.");
    assert.equal(result.hint, "Type the key again (silent install: /LLMKEY=).");
    assert.equal(endpoint.seen.length, 0);
  });
});
