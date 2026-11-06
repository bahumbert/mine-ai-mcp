// Shared by the command and control-endpoint tests: a CLI context on a fresh data root, a stack status, a recording
// control handler, the console client's stream and a poll on real time (the control endpoint runs on real sockets).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "./cli-context.ts";
import { CONTROL_HEADER, type ControlHandlers } from "./control.ts";
import { INSTALL_STEP_NAMES, type InstallSteps } from "./install-command.ts";
import { loadManifest } from "./manifest.ts";
import type { BotOutcome, StackStatus } from "./stack.ts";

/** A context whose data root (and by default app root) is a new folder; `out` and `err` both land in `out`. */
export function cliContext(name: string, appRoot?: string, dataRoot?: string) {
  const root = dataRoot ?? mkdtempSync(join(tmpdir(), `mine-ai-${name}-`));
  const out: string[] = [];
  const context: CliContext = { root, appRoot: appRoot ?? root, out: (line) => void out.push(line), err: (line) => void out.push(line), loadManifest };
  return { root, out, context };
}

/** Every install step succeeds with `<name> done`; `calls` lists the steps that ran. */
export function okInstallSteps(calls: string[] = []): InstallSteps {
  return Object.fromEntries(INSTALL_STEP_NAMES.map((name) => [name, async () => (calls.push(name), { ok: true as const, detail: `${name} done` })])) as unknown as InstallSteps;
}

/** Runs `run` with the working folder set to a new empty folder (restored after, even when `run` throws): for a test of a bare file name such as `step.json`. Tests of one file run one after the other, so the shared cwd is safe. */
export async function inTemporaryFolder<T>(run: (folder: string) => Promise<T> | T): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), "mine-ai-cwd-"));
  const before = process.cwd();
  process.chdir(folder);
  try {
    return await run(folder);
  } finally {
    process.chdir(before);
  }
}

export const STATUS: StackStatus = {
  phase: "running",
  problem: null,
  llm: { kind: "local", model: "gemma4:12b" },
  server: "local",
  join: "localhost:25565",
  minecraftVersion: "1.21.4",
  settingsPath: "C:/MineAI/settings.json",
  settingsFound: true,
  bots: [{ id: "ayla", username: "Ayla", hostPort: 25_575, status: "running" }],
  commands: { prefix: "!", audience: "everyone" },
};

/** Records what the endpoint asks of the stack; `reply` answers each bot call (`start <id>`, `stop <id>`). */
export class RecordingHandlers implements ControlHandlers {
  status$: StackStatus = STATUS;
  calls: string[] = [];
  lastStreamClosed = 0;

  constructor(private readonly reply: (call: string) => BotOutcome = () => ({ ok: true, message: "done" })) {}

  status = (): StackStatus => this.status$;
  async startBot(id: string): Promise<BotOutcome> {
    this.calls.push(`start ${id}`);
    return this.reply(`start ${id}`);
  }
  async stopBot(id: string): Promise<BotOutcome> {
    this.calls.push(`stop ${id}`);
    return this.reply(`stop ${id}`);
  }
  stop = async (): Promise<void> => void this.calls.push("stop stack");
  onLastStreamClosed = (): void => void this.lastStreamClosed++;
}

/** The header every request that changes something carries; a web page cannot send it. */
const CONTROL_HEADERS = { [CONTROL_HEADER]: "1" };
export const POST = { method: "POST", headers: CONTROL_HEADERS };

/** Polls real time (10 ms steps) until `condition` holds. */
export async function until(condition: () => boolean, limitMs = 3000): Promise<void> {
  for (let waited = 0; waited < limitMs && !condition(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), `condition not met in ${limitMs} ms`);
}

/** An attached console: the lines read so far, and a way to hang up like a closing window does. */
export async function attach(base: string): Promise<{ lines: string[]; waitFor(text: string): Promise<void>; hangUp(): void }> {
  const abort = new AbortController();
  const response = await fetch(`${base}/attach`, { signal: abort.signal, headers: CONTROL_HEADERS });
  assert.equal(response.status, 200);
  const lines: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const waiting: { text: string; resolve(): void }[] = [];
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith("data: ")) lines.push(block.slice(6));
        }
        for (const wait of waiting) if (lines.includes(wait.text)) wait.resolve();
      }
    } catch {
      // hung up
    }
  })();
  return {
    lines,
    waitFor: (text) => (lines.includes(text) ? Promise.resolve() : new Promise((resolve) => waiting.push({ text, resolve }))),
    hangUp: () => abort.abort(),
  };
}
