import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitProgram, missingGitMessage } from "./check";

function checkout(layout: "directory" | "file" | "none", content = ""): string {
  const root = mkdtempSync(join(tmpdir(), "check-git-"));
  if (layout === "directory") mkdirSync(join(root, ".git"));
  if (layout === "file") writeFileSync(join(root, ".git"), content);
  return root;
}

test("main checkout (.git directory) uses plain git", () => {
  expect(gitProgram(checkout("directory"))).toBe("git");
});

test("worktree whose .git file holds a Windows gitdir uses git.exe", () => {
  const root = checkout("file", "gitdir: D:/minecraft/mcp/mine-ai-mcp/.git/worktrees/x\n");
  expect(gitProgram(root)).toBe("git.exe");
});

test("Windows gitdir with backslashes and CRLF uses git.exe", () => {
  const root = checkout("file", "gitdir: D:\\repo\\.git\\worktrees\\x\r\n");
  expect(gitProgram(root)).toBe("git.exe");
});

test("worktree with a POSIX gitdir keeps plain git", () => {
  const root = checkout("file", "gitdir: /mnt/d/repo/.git/worktrees/x\n");
  expect(gitProgram(root)).toBe("git");
});

test("no .git at all keeps plain git", () => {
  expect(gitProgram(checkout("none"))).toBe("git");
});

test("missing git.exe gives a clear message, not an empty change list", () => {
  expect(missingGitMessage("git.exe")).toContain("git.exe");
  expect(missingGitMessage("git.exe")).toContain("Windows gitdir");
});
