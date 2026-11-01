import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ninePMountOf, rootSlug, sourceRootOf } from "./source-root.ts";

const MOUNTS = "drvfs /nonsense 9p rw 0 0\nD:\\ /mnt/d 9p rw 0 0\n/dev/sdc / ext4 rw 0 0\n";

function inTempDir(body: (folder: string) => void): void {
  const folder = mkdtempSync(path.join(tmpdir(), "source-root-"));
  try {
    body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("the root is the nearest bun.lock ancestor", () => {
  inTempDir(folder => {
    mkdirSync(path.join(folder, "a/tests/minecraft"), { recursive: true });
    writeFileSync(path.join(folder, "a/bun.lock"), "");
    assert.equal(sourceRootOf(path.join(folder, "a/tests/minecraft")), path.join(folder, "a"));
    assert.equal(sourceRootOf(path.join(folder, "a")), path.join(folder, "a"), "a directory holding bun.lock is its own root");
  });
});

test("a nested bun.lock wins over the outer one", () => {
  inTempDir(folder => {
    mkdirSync(path.join(folder, "a/inner/src"), { recursive: true });
    writeFileSync(path.join(folder, "a/bun.lock"), "");
    writeFileSync(path.join(folder, "a/inner/bun.lock"), "");
    assert.equal(sourceRootOf(path.join(folder, "a/inner/src")), path.join(folder, "a/inner"));
  });
});

test("a file path starts from its directory, and a path with no bun.lock above it gives null", () => {
  inTempDir(folder => {
    mkdirSync(path.join(folder, "a/src"), { recursive: true });
    writeFileSync(path.join(folder, "a/bun.lock"), "");
    writeFileSync(path.join(folder, "a/src/host.ts"), "");
    assert.equal(sourceRootOf(path.join(folder, "a/src/host.ts")), path.join(folder, "a"));
    mkdirSync(path.join(folder, "bare/x"), { recursive: true });
    assert.equal(sourceRootOf(path.join(folder, "bare/x")), null, "the WSL temp dir has no bun.lock above it");
  });
});

const NESTED_MOUNTS = "D:\\ /mnt/d 9p rw 0 0\n/dev/sdd /mnt/d/cache ext4 rw 0 0\nx /mnt/v v9fs rw 0 0\n";
const NINE_P_CASES: readonly { readonly what: string; readonly target: string; readonly mounts: string; readonly expected: boolean }[] = [
  { what: "a path on a 9p mount", target: "/mnt/d/x", mounts: MOUNTS, expected: true },
  { what: "the mount point itself", target: "/mnt/d", mounts: MOUNTS, expected: true },
  { what: "a path on the ext4 root", target: "/home/u/x", mounts: MOUNTS, expected: false },
  { what: "a sibling whose name only starts like the mount point (/mnt/dx is not under /mnt/d)", target: "/mnt/dx/y", mounts: MOUNTS, expected: false },
  { what: "an ext4 mount inside the 9p one (the longest prefix decides)", target: "/mnt/d/cache/a", mounts: NESTED_MOUNTS, expected: false },
  { what: "the 9p mount around that ext4 mount", target: "/mnt/d/other", mounts: NESTED_MOUNTS, expected: true },
  { what: "v9fs", target: "/mnt/v/q", mounts: NESTED_MOUNTS, expected: true },
  { what: "a mount point written with an octal space escape", target: "/mnt/my drive/x", mounts: "D:\\ /mnt/my\\040drive 9p rw 0 0\n/dev/sdc / ext4 rw 0 0\n", expected: true },
  { what: "a later mount on the same point (it hides the earlier one)", target: "/mnt/d/x", mounts: "D:\\134 /mnt/d 9p rw 0 0\n/dev/sdd /mnt/d ext4 rw 0 0\n", expected: false },
];

for (const { what, target, mounts, expected } of NINE_P_CASES) {
  test(`ninePMountOf: ${what} is ${expected ? "" : "not "}9p`, () => {
    assert.equal(ninePMountOf(target, mounts), expected);
  });
}

test("two roots with the same basename get different slugs, and a slug is stable and keeps the basename", () => {
  const one = rootSlug("/mnt/d/a/work");
  const two = rootSlug("/mnt/d/b/work");
  assert.notEqual(one, two);
  assert.equal(rootSlug("/mnt/d/a/work"), one);
  assert.match(one, /^work-[0-9a-f]{12}$/u);
});
