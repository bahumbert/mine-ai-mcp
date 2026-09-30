import { McpBotRuntime } from "./runtime-client.ts";

const USAGE = `Usage: bun agents/src/say.ts <mcp url> '<chat line>'

Makes the bot of that host say one public chat line: a scripted player talking to the agents, for demos and live
tests. Example: bun agents/src/say.ts http://127.0.0.1:25576/mcp 'Ayla, could you build me a house here?'`;

const [url, message] = process.argv.slice(2);
if (url === undefined || message === undefined || message.trim() === "") {
  console.log(USAGE);
  process.exit(2);
}

const runtime = await McpBotRuntime.connect(url, "mine-ai-say");
try {
  const state = await runtime.submit("send_message", { message }, "A scripted player line.", 10_000);
  const settled = state.state === "pending" ? await runtime.wait(state.actionId, 10_000) : state;
  console.log(settled.state === "settled" ? `${settled.status}${settled.error === null ? "" : `: ${settled.error}`}` : JSON.stringify(settled));
} finally {
  await runtime.close();
}
