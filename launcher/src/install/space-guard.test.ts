import assert from "node:assert/strict";
import test from "node:test";
import { fakeDisk } from "./fixtures/fake-disk.ts";
import { failureIfNoRoom, freeSpaceHint, guardDownload, type SpaceGuard } from "./space-guard.ts";

const GIB = 1024 ** 3;

/** A guard for a 2 GB file that unpacks to 1 GB more, all on `C:`, over a disk with `free` bytes there. */
function guardOver(free: number, folder = "C:\\data") {
  const disk = fakeDisk({ platform: "win32", existing: ["C:\\"], roots: { "C:": free } });
  const asked: number[] = [];
  const guard: SpaceGuard = {
    disk,
    reserveBytes: GIB,
    hint: freeSpaceHint(),
    needs: (downloadBytes) => {
      asked.push(downloadBytes);
      return [
        { what: "the file", folder, bytes: downloadBytes },
        { what: "its unpacked files", folder, bytes: GIB },
      ];
    },
  };
  return { guard, disk, asked };
}

test("guardDownload hands the download a hook that counts total minus the part already on disk, and lets a fitting download run", async () => {
  const { guard, asked } = guardOver(4 * GIB);
  let hookReturned: unknown = "not called";
  const result = await guardDownload(guard, false, async (beforeBody) => {
    hookReturned = await beforeBody(2 * GIB, 0.5 * GIB);
  });
  assert.equal(result, null);
  assert.equal(hookReturned, undefined);
  assert.deepEqual(asked, [1.5 * GIB], "a resumed download needs only what is still to come");
});

test("freeSpaceHint names the drive that was short and, when the step has one, another way out", () => {
  const short = { drive: "D:", needed: 2, free: 1, reserve: 1, whats: ["x"] };
  assert.equal(freeSpaceHint()(short), "Free some space on D:, then run the step again.");
  assert.equal(freeSpaceHint("choose another Ollama folder")(short), "Free some space on D:, or choose another Ollama folder, then run the step again.");
});

test("guardDownload turns a drive that is not there into a failure that says so and is not a free-space hint", async () => {
  const { guard } = guardOver(4 * GIB, "X:\\data");
  const result = await guardDownload(guard, false, async (beforeBody) => {
    await beforeBody(GIB, 0);
  });
  assert.ok(result && !result.ok);
  assert.equal(result.error, "The drive of X:\\data does not exist.");
  assert.doesNotMatch(result.hint, /free some space/iu);
  assert.match(result.hint, /run the step again/u);
});

test("a disk that cannot be read (EIO, no right to ask a share) does not stop the step: with no size known the download's own error stays the guard", async () => {
  const { guard } = guardOver(4 * GIB);
  const unreadable = { ...guard, disk: { ...guard.disk, statfs: async () => { throw Object.assign(new Error("EIO: i/o error, statfs"), { code: "EIO" }); } } };
  let downloaded = false;
  assert.equal(await guardDownload(unreadable, true, async (beforeBody) => { await beforeBody(GIB, 0); downloaded = true; }), null);
  assert.equal(downloaded, true);
  assert.equal(await failureIfNoRoom(unreadable, GIB), null);
});

test("guardDownload passes on an error that is not about space on to the step", async () => {
  const { guard } = guardOver(0);
  await assert.rejects(
    guardDownload(guard, false, async () => {
      throw new Error("Download of https://example.test/x stalled");
    }),
    /stalled/u,
  );
});
