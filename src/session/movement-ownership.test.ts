import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CONTROL_CALLS = ["setControlState", "clearControlStates"];

// check-reads: src/**/*.ts
test("movement inputs belong to navigation, survival, and the bounded raw action", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.startsWith("test-support/"));
  // Reading is the cost (537 files over the 9p mount: 1.2 s one after the other, 0.2 s together; 15-35 s at load average
  // 30), and only a file that names a control call can hold one, so the others are never parsed.
  const sources = await Promise.all(files.map(async (file) => ({ file, text: await readFile(join(root, file), "utf8") })));
  const invalid: { file: string; call: string }[] = [];
  for (const { file, text } of sources) {
    if (!CONTROL_CALLS.some((call) => text.includes(call))) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const call = node.expression.name.text;
        if (CONTROL_CALLS.includes(call)) {
          const ownsMovement = file.startsWith("navigation/") || file.startsWith("survival/");
          const preparesBody = file.startsWith("session/") && call === "clearControlStates";
          const rawBodyAction = file === "actions/raw-action/raw-action.ts" && call === "setControlState";
          if (!ownsMovement && !preparesBody && !rawBodyAction) invalid.push({ file, call });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(
    invalid,
    [],
    "Only the explicit bounded raw action may drive controls outside navigation and survival.",
  );
});
