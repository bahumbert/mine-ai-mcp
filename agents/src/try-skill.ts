import { parseArgs } from "node:util";
import { z } from "zod";
import { describeStep, stepSchema } from "./actions.ts";
import { Body } from "./body.ts";
import { McpBotRuntime } from "./runtime-client.ts";
import { runStep } from "./skills.ts";

const USAGE = `Usage: bun agents/src/try-skill.ts <mcp url> '<step json>' [--requester <username>] [--style <style id>]

Runs one skill step from the catalog (src/actions.ts) on a live bot, without any LLM: for trying skills and
blueprints in-game. --requester is the player the step is "for" (a house faces them); --style stands in for the
persona's style. Ctrl+C cancels the running action.

Example: bun agents/src/try-skill.ts http://127.0.0.1:25575/mcp '{"skill":"build","size":"small"}' --style japanese --requester Steve`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { requester: { type: "string" }, style: { type: "string" }, help: { type: "boolean" } },
});
if (values.help || positionals.length !== 2) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

const [url, json] = positionals as [string, string];
const parsed = stepSchema.safeParse(JSON.parse(json));
if (!parsed.success) {
  console.error(`[BAD_STEP] ${z.prettifyError(parsed.error)}`);
  process.exit(2);
}

const runtime = await McpBotRuntime.connect(url, "mine-ai-try-skill");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
try {
  const log = (line: string) => console.log(line);
  console.log(`running: ${describeStep(parsed.data)}`);
  const started = Date.now();
  const result = await runStep(parsed.data, {
    runtime,
    body: new Body(runtime, log),
    signal: controller.signal,
    requester: values.requester,
    style: values.style,
  });
  console.log(`${result.status} in ${Math.round((Date.now() - started) / 1000)} s${result.status === "stopped" ? "" : `: ${result.detail}`}`);
  process.exitCode = result.status === "done" ? 0 : 1;
} finally {
  await runtime.close();
}
