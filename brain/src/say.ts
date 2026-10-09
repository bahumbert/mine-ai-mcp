import { McpBotRuntime } from "./runtime-client.ts";

const USAGE = `Usage: bun brain/src/say.ts <mcp url> '<chat line>'

Makes the bot of that host say one public chat line: a scripted player talking to the agents, for demos and live
tests. Example: bun brain/src/say.ts http://127.0.0.1:25576/mcp 'Ayla, could you build me a house here?'`;

const [url, message] = process.argv.slice(2);
if (url === undefined || message === undefined || message.trim() === "") {
  console.log(USAGE);
  process.exit(2);
}

const runtime = await McpBotRuntime.connect(url, "mine-ai-say");
try {
  const outcome = await runtime.say(message);
  console.log(`${outcome.status}${outcome.error === null ? "" : `: ${outcome.error}`}`);
} finally {
  await runtime.close();
}
