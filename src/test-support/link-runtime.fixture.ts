/**
 * Child process of the link tests (`runtime-supervisor-link.test.ts`): a runtime that serves link sessions like
 * `runtime-process.ts` does, with three tools: `echo` returns its text, `slow` answers after `--slow-ms` (default 6000),
 * `wedge` blocks this thread for `--pause-ms` (default 7000: its heartbeat stops). `--ready-ms=<ms>` delays `ready`.
 * It exits when its parent goes, as the real runtime does.
 */
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { processIpcChannel, serveLinkSessions } from "../server/ipc-transport.js";
import { reportRuntimeLiveness } from "../server/runtime-liveness.js";
import { sleepMs } from "../utils/wall-timers.js";
import { blockThread } from "./block-thread.js";

/** A child-side wait: `--<name>=<ms>` on the command line, else its default. */
const waitMs = (name: string, fallback: number): number =>
  Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const slowMs = waitMs("slow-ms", 6000);
const pauseMs = waitMs("pause-ms", 7000);
const readyMs = waitMs("ready-ms", 0);
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

function fixtureServer() {
  const server = new McpServer({ name: "link-runtime-fixture", version: "1.0.0" });
  server.registerTool("echo", { inputSchema: { text: z.string() } }, ({ text: said }) => text(said));
  server.registerTool("slow", {}, async () => {
    await sleepMs(slowMs);
    return text("finished");
  });
  server.registerTool("wedge", {}, () => {
    blockThread(pauseMs);
    return text("woke");
  });
  return server.server;
}

reportRuntimeLiveness();
process.once("disconnect", () => process.exit(0));
serveLinkSessions(processIpcChannel(), fixtureServer, (line) => process.stderr.write(`${line}\n`), { open: 0, pushed: 0 });
const listener = createServer();
listener.listen(0, "127.0.0.1", async () => {
  const address = listener.address();
  await sleepMs(readyMs);
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port });
});
