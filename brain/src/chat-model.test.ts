import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { OpenAiCompatibleModel } from "./chat-model.ts";

/** An OpenAI-compatible server answering every prompt with `{}`, and `/api/ps` with `ps`; resolves to its base URL. */
async function fakeServer(ps: unknown, status = 200): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    const reply = (code: number, body: unknown) => response.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/v1/chat/completions") reply(200, { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 4321 } });
    else if (request.url === "/api/ps") reply(status, ps);
    else reply(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
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
