import { createServer } from "node:http";
import { reportRuntimeLiveness } from "../server/runtime-liveness.js";

// Loading modules blocks the event loop before the first heartbeat; the argument is how long, in milliseconds.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv.at(-1)));
reportRuntimeLiveness();
process.once("disconnect", () => process.exit(0));
const server = createServer((request, response) => response.end('{"ok":true}'));
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port });
});
