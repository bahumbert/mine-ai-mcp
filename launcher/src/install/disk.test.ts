import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import {
  checkSpace,
  DiskError,
  DiskSpaceError,
  driveOf,
  freeBytes,
  gb,
  headSize,
  modelBytesToPull,
  nearestExisting,
  realDiskDeps,
  spaceFailure,
  type DiskDeps,
  type ModelStoreDeps,
} from "./disk.ts";

const GIB = 1024 ** 3;
const RESERVE = GIB;

/** A disk where `existing` folders exist and each `roots` prefix has the given free bytes (and the `dev` number `devs` names). */
function fakeDisk(options: { platform: NodeJS.Platform; existing: string[]; roots: Record<string, number>; devs?: Record<string, string> }): DiskDeps & { statfsCalls: string[] } {
  const statfsCalls: string[] = [];
  const rootOf = (path: string) => Object.keys(options.roots).find((root) => path.toUpperCase().startsWith(root.toUpperCase()));
  return {
    platform: options.platform,
    statfsCalls,
    exists: (path) => options.existing.includes(path),
    statfs: async (path) => {
      statfsCalls.push(path);
      const root = rootOf(path);
      if (root === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, statfs '${path}'`), { code: "ENOENT" });
      return { bavail: BigInt(options.roots[root]), bsize: 1n };
    },
    dev: (path) => Object.entries(options.devs ?? {}).sort((a, b) => b[0].length - a[0].length).find(([prefix]) => path.startsWith(prefix))?.[1] ?? "0",
  };
}

const windowsDisk = (existing: string[], roots: Record<string, number>) => fakeDisk({ platform: "win32", existing, roots });

test("freeBytes of a folder that does not exist yet is the free space of its nearest existing parent", async () => {
  const deps = windowsDisk(["C:\\", "C:\\Users"], { "C:": 5 * GIB });
  assert.equal(await freeBytes("C:\\Users\\me\\AppData\\Mine AI", deps), 5 * GIB);
  assert.deepEqual(deps.statfsCalls, ["C:\\Users"]);
  assert.equal(nearestExisting("C:\\Users\\me\\x", deps), "C:\\Users");
});

test("freeBytes of a folder on a drive that is not there fails naming the folder, not with a raw ENOENT", async () => {
  const deps = windowsDisk(["C:\\"], { "C:": 5 * GIB });
  await assert.rejects(freeBytes("X:\\Mine AI\\data", deps), (error: Error) => error instanceof DiskError && error.message === "The drive of X:\\Mine AI\\data does not exist.");
  assert.equal(deps.statfsCalls.length, 0);
  await assert.rejects(checkSpace([{ what: "jar", folder: "X:\\server", bytes: 1 }], RESERVE, deps), DiskError, "a need on a missing drive is an error, not a pass");
});

test("freeBytes counts the space available to this user: bavail times bsize", async () => {
  const deps: DiskDeps = { ...windowsDisk(["C:\\"], {}), statfs: async () => ({ bavail: 30_000_000n, bsize: 4096n }) };
  assert.equal(await freeBytes("C:\\", deps), 122_880_000_000);
});

test("driveOf names the Windows drive, upper-cased and without its trailing backslash, for any spelling of the path", () => {
  const deps = windowsDisk([], {});
  assert.equal(driveOf("C:\\x", deps), "C:");
  assert.equal(driveOf("c:/y", deps), "C:");
  assert.equal(driveOf("D:\\", deps), "D:");
  assert.equal(driveOf("\\\\srv\\share\\z", deps), "\\\\SRV\\SHARE");
});

test("driveOf off Windows is the device of the nearest existing folder: two folders on one device are one drive", () => {
  const deps = fakeDisk({ platform: "linux", existing: ["/", "/mnt/d", "/mnt/d/a"], roots: {}, devs: { "/": "100", "/mnt/d": "200" } });
  assert.equal(driveOf("/mnt/d/a/new", deps), "200");
  assert.equal(driveOf("/mnt/d/b", deps), "200");
  assert.equal(driveOf("/home/x", deps), "100");
  assert.throws(() => driveOf("/nowhere", fakeDisk({ platform: "linux", existing: [], roots: {} })), DiskError, "a chain with no existing part fails like freeBytes");
});

const needFor = (what: string, folder: string, bytes: number | null) => ({ what, folder, bytes });

test("checkSpace sums two folders of one drive with one reserve: exactly enough passes, one byte short fails", async () => {
  const needs = [needFor("setup", "C:\\a", 100), needFor("model", "C:\\b", 50)];
  assert.equal(await checkSpace(needs, 50, windowsDisk(["C:\\"], { "C:": 200 })), null);
  assert.deepEqual(await checkSpace(needs, 50, windowsDisk(["C:\\"], { "C:": 199 })), { drive: "C:", needed: 200, free: 199, reserve: 50, whats: ["setup", "model"] });
});

test("checkSpace gives each drive its own reserve and reports the first short drive", async () => {
  const deps = windowsDisk(["C:\\", "D:\\"], { "C:": 3 * GIB, "D:": 2 * GIB });
  const short = await checkSpace([needFor("setup", "C:\\a", 1 * GIB), needFor("jar", "D:\\b", 1.5 * GIB)], RESERVE, deps);
  assert.equal(short?.drive, "D:");
  assert.equal(short?.needed, 2.5 * GIB);
  assert.deepEqual(short?.whats, ["jar"]);
  assert.equal(await checkSpace([needFor("setup", "C:\\a", 2 * GIB), needFor("jar", "D:\\b", 1 * GIB)], RESERVE, deps), null);
});

test("checkSpace counts an unknown size as 0, and with no size known at all lets the step go on without asking the disk", async () => {
  const deps = windowsDisk(["C:\\"], { "C:": 2 * GIB });
  const short = await checkSpace([needFor("unknown", "C:\\a", null), needFor("jar", "C:\\a", 1.5 * GIB)], RESERVE, deps);
  assert.deepEqual(short?.whats, ["jar"]);
  assert.equal(short?.needed, 2.5 * GIB);
  const noSize = windowsDisk(["C:\\"], { "C:": 10 });
  assert.equal(await checkSpace([needFor("unknown", "C:\\a", null), needFor("nothing", "C:\\a", 0)], RESERVE, noSize), null);
  assert.equal(noSize.statfsCalls.length, 0);
});

test("gb writes bytes over 1024^3 with one decimal, as Explorer shows them", () => {
  assert.equal(gb(1073741824), "1.0 GB");
  assert.equal(gb(123634737152), "115.1 GB");
});

test("spaceFailure names the drive, the needs, the free space, that the reserve is included, and the next action", () => {
  const shortfall = { drive: "D:", needed: 9 * GIB, free: 3.2 * GIB, reserve: GIB, whats: ["Ollama's setup", "Ollama"] };
  const result = spaceFailure(shortfall, "Free some space on D:, then run the step again.");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Not enough free space on D: for Ollama's setup and Ollama: it needs 9.0 GB (including the 1.0 GB Mine AI keeps free) and D: has 3.2 GB free.");
  assert.equal(result.hint, "Free some space on D:, then run the step again.");
  const thrown = new DiskSpaceError(shortfall);
  assert.equal(thrown.shortfall, shortfall, "a download hook stops the step with the shortfall");
  assert.equal(thrown.message, result.error, "the thrown error reads as the failure");
});

test("realDiskDeps asks the real disk: the free space of this folder's drive is a positive number", async () => {
  assert.ok((await freeBytes(process.cwd(), realDiskDeps)) > 0);
  assert.ok((await freeBytes(`${process.cwd()}/a/folder/that/is/not/there`, realDiskDeps)) > 0);
});

// Windows Bun only (plan T1a): a drive's root and a folder that is not there on it give the same free space from the real statfs.
test("on Windows the free space of C:\\ is positive and a missing folder on C: gives the value of its nearest existing parent", { skip: process.platform !== "win32" }, async () => {
  const root = await freeBytes("C:\\", realDiskDeps);
  assert.ok(root > 0);
  const missing = await freeBytes("C:\\mine-ai-folder-that-is-not-there\\data", realDiskDeps);
  // two reads moments apart: the pagefile, Defender or an update may move C:'s free space between them
  assert.ok(Math.abs(missing - root) < 1024 ** 3, `C:\\ ${root} against its missing folder ${missing}`);
});

// The registry's answer for gemma4:12b, measured 2026-11-06: 6 layers + config, 8021618941 bytes in all.
const REGISTRY_ANSWER = readFileSync(new URL("./fixtures/gemma4-12b-registry-manifest.json", import.meta.url), "utf8");
const PROJECTOR = "sha256-0cb0cd0a5c499d92942caa22fe5abb98f6e8874868d590e2b094ece4ac8e6d28";
const MODEL_LAYER = "sha256-bb722270d54346adc198f213851dbe0207e87c3ecf2a0aff4d92262726215391";
const FILE_PARTS = ["registry.ollama.ai", "library", "gemma4", "12b"];
const STORE = "/store";

/** A model store holding `blobs` (name -> size); the registry answers `body` with `status` unless `fetchImpl` is given. */
function fakeStore(blobs: Record<string, number>, answer: { status?: number; body?: string; fetchImpl?: typeof fetch } = {}): ModelStoreDeps & { requests: { url: string; accept: string | null }[] } {
  const requests: { url: string; accept: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), accept: new Headers(init?.headers).get("accept") });
    return new Response(answer.body ?? REGISTRY_ANSWER, { status: answer.status ?? 200 });
  }) as typeof fetch;
  return {
    requests,
    fetchImpl: answer.fetchImpl ?? fetchImpl,
    exists: (path) => Object.hasOwn(blobs, basename(path)),
    sizeOf: async (path) => blobs[basename(path)],
    listDir: async () => Object.keys(blobs),
  };
}

test("modelBytesToPull of an empty store is the registry manifest's whole size, asked with the Docker manifest type", async () => {
  const deps = fakeStore({});
  assert.equal(await modelBytesToPull(FILE_PARTS, STORE, deps), 8021618941);
  assert.deepEqual(deps.requests, [{ url: "https://registry.ollama.ai/v2/library/gemma4/manifests/12b", accept: "application/vnd.docker.distribution.manifest.v2+json" }]);
});

test("modelBytesToPull leaves out a layer whose blob is complete in the store (a shared or resumed pull)", async () => {
  assert.equal(await modelBytesToPull(FILE_PARTS, STORE, fakeStore({ [PROJECTOR]: 175115616 })), 8021618941 - 175115616);
});

test("modelBytesToPull subtracts the bytes of a layer's -partial files, never going below 0", async () => {
  assert.equal(await modelBytesToPull(FILE_PARTS, STORE, fakeStore({ [`${MODEL_LAYER}-partial`]: 1000 })), 8021618941 - 1000);
  assert.equal(await modelBytesToPull(FILE_PARTS, STORE, fakeStore({ [`${MODEL_LAYER}-partial`]: 4_000_000_000, [`${MODEL_LAYER}-partial-0`]: 4_000_000_000 })), 8021618941 - 7381383680);
});

test("modelBytesToPull asks the registry named by a model with a host, and by a namespaced model", async () => {
  const hosted = fakeStore({});
  await modelBytesToPull(["example.test:5000", "team", "tool", "v1"], STORE, hosted);
  assert.equal(hosted.requests[0].url, "https://example.test:5000/v2/team/tool/manifests/v1");
});

test("modelBytesToPull is null, never a throw, when the registry is not found, answers non-JSON or the wrong shape, or cannot be reached", async () => {
  assert.equal(await modelBytesToPull(FILE_PARTS, STORE, fakeStore({}, { status: 404, body: '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}' })), null);
  assert.equal(await modelBytesToPull(FILE_PARTS, STORE, fakeStore({}, { body: "<html>nope</html>" })), null);
  assert.equal(await modelBytesToPull(FILE_PARTS, STORE, fakeStore({}, { body: '{"layers":"none"}' })), null);
  const unreachable = fakeStore({}, { fetchImpl: (async () => { throw new TypeError("Unable to connect"); }) as unknown as typeof fetch });
  assert.equal(await modelBytesToPull(FILE_PARTS, STORE, unreachable), null);
});

test("modelBytesToPull gives up on a registry that never answers after its bound and returns null", async () => {
  const silent = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
  assert.equal(await modelBytesToPull(FILE_PARTS, STORE, { ...fakeStore({}, { fetchImpl: silent }), timeoutMs: 50 }), null);
});

/** A fetch that records each call and answers with `status` and `headers` (redirects are the real fetch's work: `redirect: "follow"` is what the test pins). */
function headFetch(headers: Record<string, string>, status = 200): { fetchImpl: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(null, { status, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("headSize is the content-length of a HEAD that follows redirects", async () => {
  const { fetchImpl, calls } = headFetch({ "content-length": "56880250" });
  assert.equal(await headSize("https://example.test/server.jar", fetchImpl), 56880250);
  assert.equal(calls[0].method, "HEAD");
  assert.equal(calls[0].redirect, "follow");
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("headSize is null without a content-length, on an error status, on a network failure and on a silent server", async () => {
  assert.equal(await headSize("https://example.test/x", headFetch({}).fetchImpl), null);
  assert.equal(await headSize("https://example.test/x", headFetch({ "content-length": "10" }, 404).fetchImpl), null);
  assert.equal(await headSize("https://example.test/x", headFetch({ "content-length": "abc" }).fetchImpl), null);
  assert.equal(await headSize("https://example.test/x", (async () => { throw new TypeError("Unable to connect"); }) as unknown as typeof fetch), null);
  const silent = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
  assert.equal(await headSize("https://example.test/x", silent, 50), null);
});
