/** Options for MCP `Client`s that list the full tool catalog: the output-schema validator that accepts every reply. */
import type { JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";

/**
 * An output-schema validator that accepts every reply, for MCP `Client`s that list the full tool catalog. The SDK
 * client builds one AJV validator per listed tool's output schema at `listTools` (`client/index.js:535`, used only by
 * `callTool`, `:108`): ~1.2 GB and 13 s per Client for this catalog (spec 2026-10-25-memory-per-bot, measured with
 * `.agent/scripts/ops/mcp-tools-mem.ts`). The server already checks each output against its schema
 * (`McpServer.validateToolOutput`, `sdk/dist/esm/server/mcp.js:132,185`). The brain keeps its own copy,
 * `ACCEPT_ANY_OUTPUT` in `brain/src/runtime-client.ts` (it imports nothing from `src/`).
 */
export const ACCEPT_ANY_OUTPUT: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};
