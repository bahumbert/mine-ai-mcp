import type { TestContext } from "node:test";

/** Replaces process.stderr.write for the rest of the test and returns the chunks written, restored when the test ends. */
export function captureStderr(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}
