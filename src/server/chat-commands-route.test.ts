import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { ChatCommandRing } from "../runtime/chat-commands.js";
import { handleChatCommandRoute, type ChatCommandRouteDeps } from "./chat-commands-route.js";

type WhisperOutcome = Awaited<ReturnType<ChatCommandRouteDeps["whisper"]>>;

/** The route mounted on the host's own kind of express app (JSON body parser, Host check), on a loopback port. */
async function mounted(t: TestContext, ring: ChatCommandRing | null, whisperOutcome: WhisperOutcome = { ok: true }) {
  const whispers: { to: string; message: string }[] = [];
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.use((request, response, next) => {
    const answered = handleChatCommandRoute(request, response, {
      ring,
      whisper: async (to, message) => {
        whispers.push({ to, message });
        return whisperOutcome;
      },
    });
    if (!answered) next();
  });
  app.use((_request, response) => {
    response.status(418).json({ fellThrough: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const call = async (path: string, init: RequestInit = {}, control = true) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(control ? { "x-mine-ai-control": "1" } : {}) },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { call, whispers, port };
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

function ringWithTwoLines() {
  const ring = new ChatCommandRing();
  ring.push({ username: "Tom", channel: "chat", message: "!bots" });
  ring.push({ username: "Tom", channel: "whisper", message: "!bot start brea" });
  return ring;
}

test("without the control header both routes answer 403 and the whisper is not sent", async (t) => {
  const { call, whispers } = await mounted(t, ringWithTwoLines());

  assert.equal((await call("/chat-commands", {}, false)).status, 403);
  assert.equal((await call("/chat-commands/whisper", post({ to: "Tom", message: "hi" }), false)).status, 403);
  assert.deepEqual(whispers, []);
});

test("with no ring (no --chat-command-prefix) both routes answer 404, and 403 still comes first without the header", async (t) => {
  const { call } = await mounted(t, null);

  assert.equal((await call("/chat-commands", {}, false)).status, 403);
  assert.equal((await call("/chat-commands")).status, 404);
  assert.equal((await call("/chat-commands/whisper", post({ to: "Tom", message: "hi" }))).status, 404);
});

test("GET after=0 gives every kept line, after=1 the ones past it, no after the lot", async (t) => {
  const ring = ringWithTwoLines();
  const { call } = await mounted(t, ring);

  for (const [path, seqs] of [["/chat-commands?after=0", [1, 2]], ["/chat-commands", [1, 2]], ["/chat-commands?after=1", [2]]] as const) {
    const { status, body } = await call(path);
    assert.equal(status, 200, path);
    assert.equal(body.epoch, ring.epoch);
    assert.equal(body.lastSeq, 2);
    assert.deepEqual((body.commands as { seq: number }[]).map(({ seq }) => seq), seqs, path);
  }
  const first = (await call("/chat-commands?after=1")).body.commands as Record<string, unknown>[];
  assert.deepEqual(Object.keys(first[0]!).sort(), ["at", "channel", "message", "seq", "username"]);
});

test("after that is not a non-negative integer is a 400 that says so", async (t) => {
  const { call } = await mounted(t, ringWithTwoLines());

  for (const bad of ["abc", "-1", "1.5", "", "1e3", "2&after=3"]) {
    const { status, body } = await call(`/chat-commands?after=${bad}`);
    assert.equal(status, 400, bad);
    assert.match(String(body.error), /after must be a non-negative integer/u, bad);
  }
});

test("a whisper is checked with send_message's own contract before anything is sent", async (t) => {
  const { call, whispers, port } = await mounted(t, ringWithTwoLines());

  const bodies = [
    { to: "Tom", message: "a\nb" },
    { to: "Tom", message: "paid §4red" },
    { to: "Tom", message: "/op Tom" },
    { to: "Tom", message: "x".repeat(234) },
    { to: "Tom Smith", message: "hi" },
    { to: "Tom\nop Tom", message: "hi" },
    { message: "hi" },
    { to: "Tom" },
    { to: "Tom", message: "hi", extra: 1 },
    ["Tom", "hi"],
  ];
  for (const body of bodies) {
    const { status, body: answer } = await call("/chat-commands/whisper", post(body));
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(answer.ok, false);
    assert.ok(String(answer.error).length > 0);
  }
  // A body that is not an object or array never reaches the route: the host's JSON parser answers 400 itself.
  const bare = await fetch(`http://127.0.0.1:${port}/chat-commands/whisper`, {
    method: "POST",
    body: '"hi"',
    headers: { "content-type": "application/json", "x-mine-ai-control": "1" },
  });
  assert.equal(bare.status, 400);
  assert.deepEqual(whispers, []);
});

test("a valid whisper is handed to the sender with its target, and its answer is the route's", async (t) => {
  const sent = await mounted(t, ringWithTwoLines());
  assert.deepEqual(await sent.call("/chat-commands/whisper", post({ to: "Tom", message: "Brea is playing." })), {
    status: 200,
    body: { ok: true },
  });
  assert.deepEqual(sent.whispers, [{ to: "Tom", message: "Brea is playing." }]);

  const failed = await mounted(t, ringWithTwoLines(), { ok: false, error: "[PLAYER_NOT_ONLINE] No player named Tom is online." });
  assert.deepEqual(await failed.call("/chat-commands/whisper", post({ to: "Tom", message: "hi" })), {
    status: 502,
    body: { ok: false, error: "[PLAYER_NOT_ONLINE] No player named Tom is online." },
  });
});

test("other paths and methods are left to the rest of the app", async (t) => {
  const { call } = await mounted(t, ringWithTwoLines());

  assert.equal((await call("/health")).status, 418);
  assert.equal((await call("/chat-commands", post({}))).status, 418);
  assert.equal((await call("/chat-commands/whisper")).status, 418);
});
