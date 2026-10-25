import { reportRuntimeLiveness } from "./runtime-liveness.js";
import { reportFaultToStderrAndParent, reportUnhandledRejections } from "./process-faults.js";
import { startFreezeWatch } from "../diagnostics/freeze-watch.js";
import type { RuntimeBootstrap } from "./host.js";

// This private entrypoint can only be booted by the package's supervising host.
if (!process.send) throw new Error("Start Mine AI MCP through startHost, not its private runtime process.");
// First: a promise left unhandled while the runtime loads or runs is reported to the supervisor, it does not end this process.
const faults = reportUnhandledRejections((fault) => reportFaultToStderrAndParent("mine-ai-mcp runtime", fault));
process.once("exit", () => faults[Symbol.dispose]());
const reporting = reportRuntimeLiveness();
process.once("disconnect", () => process.exit(1));
process.once("exit", () => reporting[Symbol.dispose]());

try {
  // Our parent serializes this typed bootstrap; it is not a public input boundary.
  const { source, configuration, freezeDirectory }: RuntimeBootstrap = JSON.parse(process.argv[2]!);
  const { startRuntimeHost } = await import("./runtime-host.js");
  // After the import: loading the modules blocks the loop for seconds (2.5 s measured, live 2026-10-11: four freeze files
  // with no markers at host start), and that is not a freeze of the running runtime.
  const freeze = startFreezeWatch({ dir: freezeDirectory, botName: configuration.instanceId });
  process.once("exit", () => freeze[Symbol.dispose]());
  const host = await startRuntimeHost(source, { ...configuration, listenHost: "127.0.0.1", listenPort: 0 });
  const requestStop = (failure?: unknown) => {
    if (failure !== undefined) reportFailure(failure);
    void host.close().catch(reportFailure);
  };
  host.server.on("error", requestStop);
  process.once("SIGINT", () => requestStop());
  process.once("SIGTERM", () => requestStop());
  const address = host.server.address();
  if (!address || typeof address === "string") throw new Error("Minecraft MCP requires a TCP listener.");
  process.send?.({ kind: "ready", port: address.port });
} catch (cause) {
  process.stderr.write(`[mine-ai-mcp] ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
}

function reportFailure(cause: unknown): void {
  process.stderr.write(`[mine-ai-mcp] ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
}
