import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadManifest } from "../manifest.ts";
import type { Settings } from "../settings.ts";
import { endpointTest } from "./endpoint.ts";
import type { InstallContext } from "./step.ts";

interface Seen {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

type Handler = (response: ServerResponse, body: Record<string, unknown>) => void;

/** An OpenAI-compatible fake; `handler` answers, and each request it saw is kept. Resolves to its `/v1` base URL. */
async function fakeEndpoint(handler: Handler) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString()));
    request.on("end", () => {
      const body = JSON.parse(text) as Record<string, unknown>;
      seen.push({ url: request.url ?? "", authorization: request.headers.authorization, body });
      handler(response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const answer = (status: number, body: unknown): Handler => (response) => void response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
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

async function withEndpoint<T>(handler: Handler, body: (endpoint: Awaited<ReturnType<typeof fakeEndpoint>>) => Promise<T>): Promise<T> {
  const endpoint = await fakeEndpoint(handler);
  try {
    return await body(endpoint);
  } finally {
    endpoint.close();
  }
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
    const started = Date.now();
    const result = await endpointTest(context(endpoint.baseUrl), { timeoutMs: 300 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /300 ms/u);
    assert.ok(Date.now() - started < 3_000);
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
