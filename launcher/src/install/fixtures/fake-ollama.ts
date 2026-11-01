// A scripted `ollama serve` for the install steps' tests: the process and the HTTP answers (/api/version, tags, pull, delete).
// Answer shapes follow Ollama's API docs and W1's serve logs (.agent/knowledge/facts/packaging.md); not measured against a
// live Ollama here, so installer check W5 walks the real pull and delete.
import type { ServeDeps, ServeProcess } from "../ollama-serve.ts";

export type FakeOllamaOptions = {
  /** An Ollama already answers on the port before we start one (a stale launcher of ours, or a player's own). */
  alreadyUp?: boolean;
  /** Our serve starts but never answers /api/version. */
  neverAnswers?: boolean;
  /** Our serve exits at once with this code. */
  exitsWith?: number;
  /** What the serve prints to its log (inference compute lines). */
  output?: string;
  models?: string[];
  /** NDJSON lines of the pull answer; an object is stringified. */
  pullLines?: (string | object)[];
  pullStatus?: number;
  deleteStatus?: number;
};

export type FakeRequest = { method: string; path: string; body: unknown };

export function fakeOllama(options: FakeOllamaOptions = {}) {
  const requests: FakeRequest[] = [];
  const started: { exe: string; env: Record<string, string> }[] = [];
  let killed = 0;
  let serving = options.alreadyUp ?? false;

  const startServe = (exe: string, env: Record<string, string>): ServeProcess => {
    started.push({ exe, env });
    serving = !options.neverAnswers;
    let listener: (text: string) => void = () => {};
    let exit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => (exit = resolve));
    if (options.exitsWith !== undefined) {
      serving = false;
      // after the log text, as a real process's 'close' event comes after its output ended
      const code = options.exitsWith;
      setTimeout(() => exit(code), 5);
    }
    return {
      onOutput(callback) {
        listener = callback;
        if (options.output) setTimeout(() => listener(options.output ?? ""), 0);
      },
      exited,
      kill() {
        killed += 1;
        serving = false;
        exit(null);
      },
    };
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!serving) throw new TypeError("fetch failed: connection refused");
    if (path === "/api/version") return Response.json({ version: "0.35.0" });
    if (path === "/api/tags") return Response.json({ models: (options.models ?? []).map((name) => ({ name, model: name })) });
    if (path === "/api/pull") return pullResponse(options);
    if (path === "/api/delete") return new Response(null, { status: options.deleteStatus ?? 200 });
    return new Response("not found", { status: 404 });
  };

  const deps: ServeDeps = { startServe, fetch: fetchImpl as typeof fetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) };
  return {
    deps,
    requests,
    started,
    get killed() {
      return killed;
    },
    requestsTo: (path: string) => requests.filter((request) => request.path === path),
  };
}

function pullResponse(options: FakeOllamaOptions): Response {
  const lines = (options.pullLines ?? [{ status: "success" }]).map((line) => (typeof line === "string" ? line : JSON.stringify(line)));
  return new Response(lines.map((line) => `${line}\n`).join(""), { status: options.pullStatus ?? 200 });
}
