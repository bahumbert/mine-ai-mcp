import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ModelUnavailable, OpenAiCompatibleModel } from "./chat-model.ts";

/** An OpenAI-compatible server answering every prompt with `{}`, and `/api/ps` with `ps`; resolves to its base URL. */
async function fakeServer(ps: unknown, status = 200): Promise<{ server: Server; baseUrl: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const reply = (code: number, body: unknown) => response.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/v1/chat/completions") {
      let text = "";
      request.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      request.on("end", () => {
        bodies.push(JSON.parse(text) as Record<string, unknown>);
        reply(200, { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 4321 } });
      });
    } else if (request.url === "/api/ps") reply(status, ps);
    else reply(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies };
}

const config = (baseUrl: string, contextTokens: number | null = null) => ({ baseUrl, apiKey: null, model: "qwen3:30b", jsonMode: true, timeoutMs: 5_000, temperature: 0, contextTokens });

test("an Ollama reply carries its prompt size and the context window the model was loaded with", async () => {
  const { server, baseUrl } = await fakeServer({ models: [{ name: "other", context_length: 2048 }, { name: "qwen3:30b", model: "qwen3:30b", context_length: 8192 }] });
  try {
    const model = new OpenAiCompatibleModel(config(baseUrl));
    assert.deepEqual(await model.complete([{ role: "user", content: "hi" }], new AbortController().signal), { text: "{}", promptTokens: 4321, contextTokens: 8192 });
  } finally {
    server.close();
  }
});

test("a configured context wins, and a server that is not Ollama leaves it unknown", async () => {
  const { server, baseUrl } = await fakeServer({}, 404);
  try {
    const signal = new AbortController().signal;
    const configured = new OpenAiCompatibleModel(config(baseUrl, 32768));
    assert.equal((await configured.complete([{ role: "user", content: "hi" }], signal)).contextTokens, 32768);
    const unknown = new OpenAiCompatibleModel(config(baseUrl));
    assert.equal((await unknown.complete([{ role: "user", content: "hi" }], signal)).contextTokens, null);
  } finally {
    server.close();
  }
});

test("a thinking setting is sent as reasoning_effort, and nothing is sent without one", async () => {
  const { server, baseUrl, bodies } = await fakeServer({}, 404);
  try {
    const signal = new AbortController().signal;
    await new OpenAiCompatibleModel({ ...config(baseUrl), reasoningEffort: "none" }).complete([{ role: "user", content: "hi" }], signal);
    await new OpenAiCompatibleModel(config(baseUrl)).complete([{ role: "user", content: "hi" }], signal);
    assert.equal(bodies[0]?.reasoning_effort, "none");
    assert.equal("reasoning_effort" in (bodies[1] ?? {}), false);
  } finally {
    server.close();
  }
});

/** A server that answers `/v1/chat/completions` with `respond` (never when it is null), for the cases the model server fails. */
async function failingServer(respond: ((response: ServerResponse) => void) | null): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    request.resume();
    respond?.(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

const ASK = [{ role: "user" as const, content: "hi" }];

test("a request that outlives the timeout is ModelUnavailable", async () => {
  const { server, baseUrl } = await failingServer(null);
  try {
    const model = new OpenAiCompatibleModel({ ...config(baseUrl), timeoutMs: 50 });
    await assert.rejects(model.complete(ASK, new AbortController().signal), (error) => error instanceof ModelUnavailable && error.cause !== undefined);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("an HTTP 503 is ModelUnavailable and keeps the status and the body in its message", async () => {
  const { server, baseUrl } = await failingServer((response) => response.writeHead(503).end("model is loading"));
  try {
    const model = new OpenAiCompatibleModel(config(baseUrl));
    await assert.rejects(model.complete(ASK, new AbortController().signal), (error) => error instanceof ModelUnavailable && /\[LLM_HTTP_503\] qwen3:30b: model is loading/u.test(error.message));
  } finally {
    server.close();
  }
});

test("a refused connection is ModelUnavailable", async () => {
  const { server, baseUrl } = await failingServer(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await assert.rejects(new OpenAiCompatibleModel(config(baseUrl)).complete(ASK, new AbortController().signal), (error) => error instanceof ModelUnavailable);
});

test("a completion that cannot be read is ModelUnavailable", async () => {
  const { server, baseUrl } = await failingServer((response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [] })));
  try {
    await assert.rejects(new OpenAiCompatibleModel(config(baseUrl)).complete(ASK, new AbortController().signal), (error) => error instanceof ModelUnavailable);
  } finally {
    server.close();
  }
});

test("a call aborted by its caller rejects with the abort, not ModelUnavailable", async () => {
  const { server, baseUrl } = await failingServer(null);
  try {
    const controller = new AbortController();
    const asked = new OpenAiCompatibleModel(config(baseUrl)).complete(ASK, controller.signal);
    controller.abort(new Error("stopped"));
    await assert.rejects(asked, (error) => !(error instanceof ModelUnavailable));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
