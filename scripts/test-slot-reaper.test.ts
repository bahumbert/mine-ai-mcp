/** The reaper's proc reader at the slot boundary: a process that exits mid-read is gone, other errors are not. */
import { expect, test } from "bun:test";
import { readProc } from "./test-slot-reaper.js";

test("a proc file whose process exits between open and read reads as gone (ESRCH, ENOENT), and other read errors still throw", () => {
  const exited = Object.assign(new Error("ESRCH: no such process, read"), { code: "ESRCH" });
  expect(readProc("/proc/4000000/comm", () => { throw exited; })).toBe("");
  const missing = Object.assign(new Error("ENOENT: no such file or directory, open"), { code: "ENOENT" });
  expect(readProc("/proc/4000000/comm", () => { throw missing; })).toBe("");
  const denied = Object.assign(new Error("EACCES: permission denied, read"), { code: "EACCES" });
  expect(() => readProc("/proc/1/comm", () => { throw denied; })).toThrow("EACCES");
});
