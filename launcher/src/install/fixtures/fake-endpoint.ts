// An OpenAI-compatible endpoint on a real local socket for the endpoint tests (`endpoint.test.ts`,
// `endpoint-models.test.ts`), and the install context that points at it.
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../../manifest.ts";
import type { Settings } from "../../settings.ts";
import { loadSettings } from "../../settings.ts";
import type { InstallContext } from "../step.ts";

export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  /** The JSON body of a POST; `{}` for a GET. */
  readonly body: Record<string, unknown>;
}

export type Handler = (response: ServerResponse, body: Record<string, unknown>, seen: Seen) => void;

export interface FakeEndpoint {
  /** `http://127.0.0.1:<port>/v1`. */
  readonly baseUrl: string;
  /** `http://127.0.0.1:<port>`: the URL a player types without `/v1`. */
  readonly rootUrl: string;
  readonly seen: Seen[];
  close(): void;
}

/** Starts the fake; `handler` answers each request and every request it saw is kept in `seen`. */
export async function fakeEndpoint(handler: Handler): Promise<FakeEndpoint> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString()));
    request.on("end", () => {
      const body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      const entry: Seen = { method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body };
      seen.push(entry);
      handler(response, body, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl: `${rootUrl}/v1`,
    rootUrl,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Runs `body` against a fake endpoint that is closed afterwards, whatever `body` does. */
export async function withFakeEndpoint<T>(handler: Handler, body: (endpoint: FakeEndpoint) => Promise<T>): Promise<T> {
  const endpoint = await fakeEndpoint(handler);
  try {
    return await body(endpoint);
  } finally {
    endpoint.close();
  }
}

/** A handler that answers every request the same way: callable with the response alone, and usable wherever a `Handler` is. */
export type Answer = (response: ServerResponse, ...ignored: unknown[]) => void;

/** A JSON answer with this status. */
export const answerJson = (status: number, body: unknown): Answer => (response) => void response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
/** A plain-text answer: what Ollama's root gives for a path it does not have (`404 page not found`, measured 2026-11-06). */
export const answerText = (status: number, text: string, contentType = "text/plain"): Answer => (response) => void response.writeHead(status, { "content-type": contentType }).end(text);

/** A remote-endpoint install context on a fresh data root (the settings are the defaults with this `llm`). */
export function remoteContext(llm: Record<string, unknown> & { baseUrl: string }, root: string = mkdtempSync(join(tmpdir(), "mine-ai-endpoint-"))): InstallContext {
  const manifest = loadManifest();
  const defaults = loadSettings(root, manifest);
  const settings = { ...defaults, llm: { kind: "remote", apiKey: "sk-test", model: "big-model", ...llm } } as Settings;
  return { manifest, settings, root, onProgress: () => {} };
}
