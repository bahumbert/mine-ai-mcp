import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import test from "node:test";
import { freePort, PORT_SEARCH_SPAN } from "./ports.ts";

function listen(port: number, host = "127.0.0.1"): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

/** A port nothing holds right now. */
async function unusedPort(): Promise<number> {
  const probe = await listen(0);
  const port = (probe.address() as { port: number }).port;
  await close(probe);
  return port;
}

test("freePort returns the start port when nothing holds it", async () => {
  const port = await unusedPort();
  assert.equal(await freePort(port), port);
});

// Windows lets a bind on 127.0.0.1 succeed beside a wildcard holder (measured with Windows Bun 1.4.2 in the task
// review of W2a), so each holder address must make the port count as held: the player's own server on 0.0.0.0 is the
// usual one.
for (const holderAddress of ["127.0.0.1", "0.0.0.0", "::"]) {
  test(`freePort skips a port held on ${holderAddress}`, async () => {
    const held = await listen(0, holderAddress);
    try {
      const port = (held.address() as { port: number }).port;
      const found = await freePort(port);
      assert.ok(found > port && found < port + PORT_SEARCH_SPAN, `got ${found} for held ${port}`);
    } finally {
      await close(held);
    }
  });
}

test("freePort skips the ports in taken, even though they are free", async () => {
  const port = await unusedPort();
  const found = await freePort(port, new Set([port]));
  assert.ok(found > port);
});

for (const [start, length, range] of [
  [30_000, PORT_SEARCH_SPAN, "30000-30099"],
  [65_530, 6, "65530-65535"],
] as const) {
  test(`freePort with every port of ${range} taken fails naming the range`, async () => {
    const taken = new Set(Array.from({ length }, (_, i) => start + i));
    await assert.rejects(freePort(start, taken), new RegExp(range, "u"));
  });
}

test("freePort refuses a start that is not a TCP port", async () => {
  await assert.rejects(freePort(0), /port/u);
  await assert.rejects(freePort(70_000), /port/u);
});
