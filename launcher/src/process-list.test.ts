import assert from "node:assert/strict";
import test from "node:test";
import { listProcesses, normalizeImageName, parsePsOutput } from "./process-list.ts";

test("listProcesses sees this process with its own parent pid and a bun or node image", async () => {
  const me = (await listProcesses()).find((entry) => entry.pid === process.pid);
  assert.ok(me, "this process is in the list");
  assert.equal(me.parentPid, process.ppid);
  assert.match(normalizeImageName(me.image), /^(bun|node)/u);
});

test("parsePsOutput reads pid, parent pid and image name, image names with spaces included", () => {
  const text = "    1     0 systemd\n 4242  4000 llama-server\n 77 1 Web Content\n\nnot a line\n";
  assert.deepEqual(parsePsOutput(text), [
    { pid: 1, parentPid: 0, image: "systemd" },
    { pid: 4242, parentPid: 4000, image: "llama-server" },
    { pid: 77, parentPid: 1, image: "Web Content" },
  ]);
});

test("normalizeImageName drops the folder and .exe and lowercases, for both path styles", () => {
  assert.equal(normalizeImageName("Ollama.EXE"), "ollama");
  assert.equal(normalizeImageName("C:\\Tools\\bun.exe"), "bun");
  assert.equal(normalizeImageName("/usr/bin/java"), "java");
  assert.equal(normalizeImageName("llama-server.exe"), "llama-server");
});
