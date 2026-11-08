import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inTemporaryFolder } from "../cli-test-support.ts";
import { settingsPath } from "../settings.ts";
import { endpointModels } from "./endpoint-models.ts";
import { answerJson, answerText, fakeEndpoint, remoteContext, withFakeEndpoint, type FakeEndpoint, type Handler } from "./fixtures/fake-endpoint.ts";

/** Entries cut from OpenRouter's answer of 2026-11-06 (`GET /api/v1/models`, no key; field names and value shapes as measured). */
const OPENROUTER_ANSWER = {
  data: [
    {
      id: "openai/gpt-4o-mini",
      name: "OpenAI: GPT-4o-mini",
      context_length: 128_000,
      architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
      pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000075" },
      supported_parameters: ["frequency_penalty", "max_tokens", "response_format", "seed", "stop", "temperature", "tools"],
    },
    { id: "acme/image-maker", name: "Acme Images", context_length: 4096, architecture: { output_modalities: ["image"] }, pricing: { prompt: "0.000001", completion: "0.000002" } },
    { id: "vendor/bare-model", name: "Bare" },
    {
      id: "vendor/no-json-mode",
      context_length: 32_768,
      architecture: { output_modalities: ["text"] },
      pricing: { prompt: "0.0000015", completion: "0.000006" },
      supported_parameters: ["temperature", "reasoning_effort"],
    },
    {
      id: "openrouter/auto",
      context_length: 2_000_000,
      architecture: { output_modalities: ["text", "image"] },
      pricing: { prompt: "-1", completion: "-1" },
      supported_parameters: ["response_format", "reasoning_effort", "temperature"],
    },
    {
      id: "stealth/crouton-alpha",
      context_length: 200_000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["response_format", "reasoning_effort", "temperature"],
    },
  ],
};

/** The lines the setup must read for `OPENROUTER_ANSWER`, sorted by id (the image-only model is left out). */
const OPENROUTER_LINES = [
  "openai/gpt-4o-mini\t128k context, $0.15 / $0.6 per million tokens in / out, does not list reasoning_effort",
  "openrouter/auto\t2000k context, price varies",
  "stealth/crouton-alpha\t200k context, free",
  "vendor/bare-model\t",
  "vendor/no-json-mode\t33k context, $1.5 / $6 per million tokens in / out, does not list response_format",
];

/** Ollama 0.35.0's `GET /v1/models` with `gemma4:12b` pulled, and with an empty store (measured 2026-11-06 on this PC). */
const OLLAMA_ANSWER = { object: "list", data: [{ id: "gemma4:12b", object: "model", created: 1_791_982_194, owned_by: "library" }] };
const OLLAMA_EMPTY_STORE_ANSWER = { object: "list", data: null };

const listFileIn = (): string => join(mkdtempSync(join(tmpdir(), "mine-ai-models-")), "deeper", "models.txt");
const modelsAnswer = (body: unknown): Handler => answerJson(200, body);
/** Ollama's root answers the plain 404 and `/v1` answers. */
const onlyUnderV1 = (v1: Handler): Handler => (response, body, seen) => (seen.url.startsWith("/v1/") ? v1 : answerText(404, "404 page not found"))(response, body, seen);

test("the list is one line per text model, `<id>`, a tab and the info built from the fields the entry has, sorted by id; an image-only model is left out", async () => {
  await withFakeEndpoint(modelsAnswer(OPENROUTER_ANSWER), async (endpoint) => {
    const listFile = listFileIn();
    const result = await endpointModels(remoteContext({ baseUrl: endpoint.baseUrl }), { url: endpoint.baseUrl, savedKey: false, listFile });
    assert.deepEqual(result, { ok: true, detail: "5 models listed." });
    assert.equal(readFileSync(listFile, "utf8"), `${OPENROUTER_LINES.join("\n")}\n`);
    assert.deepEqual(endpoint.seen.map((request) => `${request.method} ${request.url}`), ["GET /v1/models"]);
  });
});

test("--list with a bare file name is written in the working folder (Windows Bun throws EEXIST on mkdir of \".\")", async () => {
  await withFakeEndpoint(modelsAnswer(OLLAMA_ANSWER), async (endpoint) => {
    await inTemporaryFolder(async (folder) => {
      const result = await endpointModels(remoteContext({ baseUrl: endpoint.baseUrl }), { url: endpoint.baseUrl, savedKey: false, listFile: "models.txt" });
      assert.deepEqual(result, { ok: true, detail: "1 model listed." });
      assert.equal(readFileSync(join(folder, "models.txt"), "utf8"), "gemma4:12b\t\n");
    });
  });
});

test("Ollama's own answer lists its pulled model with no info; the info keeps only what the entry gives", async () => {
  await withFakeEndpoint(modelsAnswer(OLLAMA_ANSWER), async (endpoint) => {
    const listFile = listFileIn();
    await endpointModels(remoteContext({ baseUrl: endpoint.baseUrl }), { url: endpoint.baseUrl, savedKey: false, listFile });
    assert.equal(readFileSync(listFile, "utf8"), "gemma4:12b\t\n");
  });
});

test("the parameters named as missing follow what the brain sends: JSON mode off and no reasoning effort drop them from the check", async () => {
  await withFakeEndpoint(modelsAnswer({ data: [{ id: "m", supported_parameters: ["stop"] }] }), async (endpoint) => {
    const ctx = remoteContext({ baseUrl: endpoint.baseUrl });
    const quiet = { ...ctx, manifest: { ...ctx.manifest, brainEnv: { MINE_AI_LLM_JSON_MODE: "false", MINE_AI_LLM_REASONING_EFFORT: "" } } };
    const listFile = listFileIn();
    await endpointModels(quiet, { url: endpoint.baseUrl, savedKey: false, listFile });
    assert.equal(readFileSync(listFile, "utf8"), "m\tdoes not list temperature\n");
  });
});

test("a URL without /v1 that answers 404 while /v1 lists is corrected and told, and no settings are written", async () => {
  await withFakeEndpoint(onlyUnderV1(modelsAnswer(OLLAMA_ANSWER)), async (endpoint) => {
    const ctx = remoteContext({ baseUrl: endpoint.rootUrl });
    const result = await endpointModels(ctx, { url: endpoint.rootUrl, savedKey: false, listFile: listFileIn() });
    const notice = `The endpoint URL was changed from ${endpoint.rootUrl} to ${endpoint.baseUrl}: ${endpoint.rootUrl} answered 404 (not found) and ${endpoint.baseUrl} answers as an OpenAI-compatible API.`;
    assert.equal(result.ok, true);
    assert.equal(result.correctedUrl, endpoint.baseUrl);
    assert.equal(result.notice, notice);
    if (result.ok) assert.equal(result.detail, `${notice} 1 model listed.`);
    assert.deepEqual(endpoint.seen.map((request) => request.url), ["/models", "/v1/models"]);
    assert.equal(existsSync(settingsPath(ctx.root)), false);
  });
});

// Review 2026-11-06 S2: the step writes no settings, so a URL read from the settings is not "changed" by the listing.
test("no --url: the corrected URL is told as where the endpoint answers, to be saved by endpoint-test, never as changed; the URL is still returned and nothing is written", async () => {
  await withFakeEndpoint(onlyUnderV1(modelsAnswer(OLLAMA_ANSWER)), async (endpoint) => {
    const ctx = remoteContext({ baseUrl: endpoint.rootUrl });
    const listFile = listFileIn();
    const result = await endpointModels(ctx, { savedKey: false, listFile });
    const notice = `${endpoint.rootUrl} answers at ${endpoint.baseUrl}; run install endpoint-test (or the setup) to save it.`;
    assert.equal(result.ok, true);
    assert.equal(result.correctedUrl, endpoint.baseUrl);
    assert.equal(result.notice, notice);
    if (result.ok) assert.equal(result.detail, `${notice} 1 model listed.`);
    assert.equal(readFileSync(listFile, "utf8"), "gemma4:12b\t\n");
    assert.equal(existsSync(settingsPath(ctx.root)), false, "settings.json was written");
  });
});

test("no --url and the corrected endpoint lists no text model: the failure carries the same unsaved-URL notice", async () => {
  const imageOnly = { data: [{ id: "acme/image-maker", architecture: { output_modalities: ["image"] } }] };
  await withFakeEndpoint(onlyUnderV1(modelsAnswer(imageOnly)), async (endpoint) => {
    const result = await endpointModels(remoteContext({ baseUrl: endpoint.rootUrl }), { savedKey: false, listFile: listFileIn() });
    assert.equal(result.ok, false);
    assert.equal(result.notice, `${endpoint.rootUrl} answers at ${endpoint.baseUrl}; run install endpoint-test (or the setup) to save it.`);
    if (!result.ok) assert.match(result.error, /lists no text model/u);
  });
});

test("which key is sent: --key as a bearer token, an empty or no key none, --saved-key and the no-flag form the settings' key; the key is never in a result or the list file", async () => {
  await withFakeEndpoint(modelsAnswer(OLLAMA_ANSWER), async (endpoint) => {
    const ctx = remoteContext({ baseUrl: endpoint.baseUrl, apiKey: "sk-from-settings" });
    const listFile = listFileIn();
    const results = [
      await endpointModels(ctx, { url: endpoint.baseUrl, key: "sk-typed", savedKey: false, listFile }),
      await endpointModels(ctx, { url: endpoint.baseUrl, key: "", savedKey: false, listFile }),
      await endpointModels(ctx, { url: endpoint.baseUrl, savedKey: false, listFile }),
      await endpointModels(ctx, { url: `${endpoint.baseUrl}/`, savedKey: true, listFile }),
      await endpointModels(ctx, { savedKey: false, listFile }),
    ];
    assert.deepEqual(endpoint.seen.map((request) => request.authorization), ["Bearer sk-typed", undefined, undefined, "Bearer sk-from-settings", "Bearer sk-from-settings"]);
    assert.ok(results.every((result) => result.ok));
    assert.ok(!JSON.stringify(results).includes("sk-"));
    assert.ok(!readFileSync(listFile, "utf8").includes("sk-"));
  });
});

test("a saved key that cannot be read here fails with the setup-facing text and no request, but a key typed now still works", async () => {
  await withFakeEndpoint(modelsAnswer(OLLAMA_ANSWER), async (endpoint) => {
    const ctx = remoteContext({ baseUrl: endpoint.baseUrl, apiKey: "", apiKeyProtected: "QUJD", keyUnreadable: true });
    for (const options of [{ savedKey: true, url: endpoint.baseUrl }, { savedKey: false }]) {
      const result = await endpointModels(ctx, { ...options, listFile: listFileIn() });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, "The saved API key was saved by another Windows user or on another PC and cannot be read here.");
        assert.equal(result.hint, "Type the key again (silent install: /LLMKEY=).");
      }
    }
    assert.equal(endpoint.seen.length, 0);
    const typed = await endpointModels(ctx, { url: endpoint.baseUrl, key: "sk-now", savedKey: false, listFile: listFileIn() });
    assert.equal(typed.ok, true);
  });
});

test("--saved-key with settings that hold no remote endpoint fails and says to type the key; no URL and no remote settings fails too", async () => {
  const local = { ...remoteContext({ baseUrl: "http://x.invalid/v1" }) };
  const settings = { ...local.settings, llm: { kind: "local", model: "gemma4:12b" } } as typeof local.settings;
  for (const options of [{ savedKey: true, url: "http://x.invalid/v1" }, { savedKey: false }]) {
    const result = await endpointModels({ ...local, settings }, { ...options, listFile: listFileIn() });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.hint, /--url|--key/u);
  }
});

for (const [label, handler, reason] of [
  ["404 on both the URL and /v1", answerText(404, "404 page not found"), /\(HTTP 404\)\.$/u],
  ["an HTML page", answerText(200, "<html>Welcome</html>", "text/html"), /\(the answer is not JSON\)\.$/u],
  ["an empty object", modelsAnswer({}), /\(the answer has no model list\)\.$/u],
  ["a JSON array", modelsAnswer([{ id: "a" }]), /\(the answer has no model list\)\.$/u],
  ["a body that is no JSON", answerText(200, "models: a, b"), /\(the answer is not JSON\)\.$/u],
  ["entries without an id", modelsAnswer({ data: [{ name: "a" }, { id: "" }] }), /\(the answer holds no model ids\)\.$/u],
  ["a 401 with a JSON error (its message is in the reason)", answerJson(401, { error: { message: "No auth credentials found" } }), /\(HTTP 401: No auth credentials found\)\.$/u],
  ["a gateway's HTML 502 (the page is not pasted into the reason)", answerText(502, "<!doctype html><html><body>Bad gateway</body></html>", "text/html"), /\(HTTP 502\)\.$/u],
] as const) {
  test(`${label} is 'no model list', says to type the model name, and writes no file`, async () => {
    await withFakeEndpoint(handler, async (endpoint) => {
      const listFile = listFileIn();
      const result = await endpointModels(remoteContext({ baseUrl: endpoint.baseUrl }), { url: endpoint.baseUrl, savedKey: false, listFile });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /^The endpoint gives no model list /u);
        assert.match(result.error, reason);
        assert.match(result.hint, /Type the model name\./u);
      }
      assert.equal(existsSync(listFile), false);
    });
  });
}

test("root 404 and a /v1 that is no OpenAI API: not corrected, the reason says both were tried", async () => {
  await withFakeEndpoint(onlyUnderV1(answerText(401, "<html>Sign in</html>", "text/html")), async (endpoint) => {
    const result = await endpointModels(remoteContext({ baseUrl: endpoint.rootUrl }), { url: endpoint.rootUrl, savedKey: false, listFile: listFileIn() });
    assert.equal(result.ok, false);
    assert.equal(result.correctedUrl, undefined);
    if (!result.ok) assert.ok(result.hint.includes(`(${endpoint.baseUrl} did not answer as an OpenAI-compatible API either)`), result.hint);
  });
});

test("an endpoint with no text model (an empty store answers data null, as Ollama does) is 'lists no text model' and writes no file", async () => {
  for (const body of [OLLAMA_EMPTY_STORE_ANSWER, { data: [] }, { data: [{ id: "acme/image-maker", architecture: { output_modalities: ["image"] } }] }]) {
    await withFakeEndpoint(modelsAnswer(body), async (endpoint) => {
      const listFile = listFileIn();
      const result = await endpointModels(remoteContext({ baseUrl: endpoint.baseUrl }), { url: endpoint.baseUrl, savedKey: false, listFile });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /lists no text model/u);
        assert.match(result.hint, /Type the model name/u);
      }
      assert.equal(existsSync(listFile), false);
    });
  }
});

test("an endpoint that never answers fails after the bound, naming it; a closed port says it cannot be reached", async () => {
  await withFakeEndpoint(() => {}, async (endpoint) => {
    const started = performance.now();
    const result = await endpointModels(remoteContext({ baseUrl: endpoint.baseUrl }), { url: endpoint.baseUrl, savedKey: false, listFile: listFileIn() }, { timeoutMs: 250 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /no answer within 250 ms/u);
    assert.ok(performance.now() - started < 3_000);
  });
  const closed: FakeEndpoint = await fakeEndpoint(() => {});
  closed.close();
  const unreachable = await endpointModels(remoteContext({ baseUrl: closed.baseUrl }), { url: closed.baseUrl, savedKey: false, listFile: listFileIn() });
  assert.equal(unreachable.ok, false);
  if (!unreachable.ok) assert.match(unreachable.error, /Cannot reach/u);
});

test("ids with a tab or a line break are left out (they would break the file's lines), a repeated id is listed once", async () => {
  await withFakeEndpoint(modelsAnswer({ data: [{ id: "a" }, { id: "a" }, { id: "b\tc" }, { id: "d\ne" }, { id: "f g" }] }), async (endpoint) => {
    const listFile = listFileIn();
    const result = await endpointModels(remoteContext({ baseUrl: endpoint.baseUrl }), { url: endpoint.baseUrl, savedKey: false, listFile });
    assert.equal(readFileSync(listFile, "utf8"), "a\t\nf g\t\n");
    assert.equal(result.ok && result.detail, "2 models listed.");
  });
});
