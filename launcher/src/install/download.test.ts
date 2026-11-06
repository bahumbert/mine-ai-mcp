import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { DownloadError, downloadFailureHint, downloadVerified } from "./download.ts";

const payload = Buffer.from("the bytes of a pinned download ".repeat(5000));
const sha256 = createHash("sha256").update(payload).digest("hex");
const sha1 = createHash("sha1").update(payload).digest("hex");

interface FakeHost {
  readonly url: string;
  readonly requests: { range: string | null }[];
  stop(): void;
}

/**
 * Serves `payload` at `/file`. `supportsRange`: answers 206 to a Range. `cutAfter`: the first answer's socket dies after
 * that many bytes. `stallAfter`: the first answer sends that many bytes, then nothing, with the socket left open.
 */
function serve(options: { supportsRange?: boolean; cutAfter?: number; stallAfter?: number; body?: Buffer } = {}): FakeHost {
  const body = options.body ?? payload;
  const requests: { range: string | null }[] = [];
  let cutDone = options.cutAfter === undefined && options.stallAfter === undefined;
  const server = createServer((request, response) => {
    if (request.url !== "/file") return void response.writeHead(404, "Not Found").end("no such file");
    const range = request.headers.range ?? null;
    requests.push({ range });
    let start = 0;
    let status = 200;
    const headers: Record<string, string> = {};
    const match = range === null ? null : /^bytes=(\d+)-$/u.exec(range);
    if (match !== null && options.supportsRange === true) {
      start = Number(match[1]);
      if (start >= body.length) return void response.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
      status = 206;
      headers["content-range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
    }
    const slice = body.subarray(start);
    headers["content-length"] = String(slice.length);
    response.writeHead(status, headers);
    if (cutDone) return void response.end(slice);
    cutDone = true;
    if (options.stallAfter !== undefined) return void response.write(slice.subarray(0, options.stallAfter));
    response.write(slice.subarray(0, options.cutAfter), () => setTimeout(() => response.socket?.destroy(), 20));
  });
  server.listen(0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/file`, requests, stop: () => { server.closeAllConnections(); server.close(); } };
}

const scratch = () => join(mkdtempSync(join(tmpdir(), "download-")), "file.bin");

for (const [name, hash] of [["SHA-256", { sha256 }], ["SHA-1", { sha1 }]] as const) {
  test(`a download with the right ${name} is written, its .part is gone and its progress ends at 1`, async () => {
    const host = serve();
    const dest = scratch();
    const fractions: number[] = [];
    try {
      await downloadVerified(host.url, dest, hash, (fraction) => fractions.push(fraction));
      assert.deepEqual(readFileSync(dest), payload);
      assert.equal(existsSync(`${dest}.part`), false);
      assert.equal(fractions.at(-1), 1);
      assert.deepEqual(fractions, [...fractions].sort((a, b) => a - b));
    } finally {
      host.stop();
    }
  });
}

test("a wrong hash deletes the .part and fails with the URL and both hashes", async () => {
  const host = serve();
  const dest = scratch();
  const wrong = "0".repeat(64);
  try {
    await assert.rejects(downloadVerified(host.url, dest, { sha256: wrong }), (error: Error) => {
      assert.ok(error.message.includes(host.url), error.message);
      assert.ok(error.message.includes(wrong), error.message);
      assert.ok(error.message.includes(sha256), error.message);
      return true;
    });
    assert.equal(existsSync(dest), false);
    assert.equal(existsSync(`${dest}.part`), false);
  } finally {
    host.stop();
  }
});

test("a download cut at half is resumed with a Range request and ends verified", async () => {
  const half = Math.floor(payload.length / 2);
  const host = serve({ supportsRange: true, cutAfter: half });
  const dest = scratch();
  try {
    await assert.rejects(downloadVerified(host.url, dest, { sha256 }));
    assert.equal(existsSync(dest), false);
    assert.equal(statSync(`${dest}.part`).size, half);
    await downloadVerified(host.url, dest, { sha256 });
    assert.deepEqual(readFileSync(dest), payload);
    assert.deepEqual(host.requests.map((request) => request.range), [null, `bytes=${half}-`]);
  } finally {
    host.stop();
  }
});

test("a server without Range makes the resume restart from zero", async () => {
  const host = serve({ supportsRange: false, cutAfter: 1000 });
  const dest = scratch();
  try {
    await assert.rejects(downloadVerified(host.url, dest, { sha256 }));
    await downloadVerified(host.url, dest, { sha256 });
    assert.deepEqual(readFileSync(dest), payload);
  } finally {
    host.stop();
  }
});

test("a .part longer than the file restarts the download instead of failing", async () => {
  const host = serve({ supportsRange: true });
  const dest = scratch();
  writeFileSync(`${dest}.part`, Buffer.concat([payload, Buffer.from("junk")]));
  try {
    await downloadVerified(host.url, dest, { sha256 });
    assert.deepEqual(readFileSync(dest), payload);
  } finally {
    host.stop();
  }
});

test("a file already present with the right hash makes no request", async () => {
  const host = serve();
  const dest = scratch();
  writeFileSync(dest, payload);
  try {
    await downloadVerified(host.url, dest, { sha256 });
    assert.equal(host.requests.length, 0);
  } finally {
    host.stop();
  }
});

test("a file present with another hash is downloaded again", async () => {
  const host = serve();
  const dest = scratch();
  writeFileSync(dest, "an older version");
  try {
    await downloadVerified(host.url, dest, { sha256 });
    assert.deepEqual(readFileSync(dest), payload);
  } finally {
    host.stop();
  }
});

test("an HTTP error status fails naming the URL and the status", async () => {
  const host = serve();
  const dest = scratch();
  try {
    await assert.rejects(downloadVerified(`${host.url}-missing`, dest, { sha256 }), /-missing: HTTP 404/u);
    assert.equal(existsSync(`${dest}.part`), false);
  } finally {
    host.stop();
  }
});

test("a body that errors mid-way keeps the .part for the next call", async () => {
  const dest = scratch();
  const half = 1000;
  let sent = false;
  const failing = (async () => {
    const stream = new ReadableStream({
      pull(controller) {
        if (sent) return controller.error(new Error("connection reset"));
        sent = true;
        controller.enqueue(payload.subarray(0, half));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-length": String(payload.length) } });
  }) as unknown as typeof fetch;
  await assert.rejects(downloadVerified("https://example.invalid/file", dest, { sha256 }, undefined, failing), /connection reset/u);
  assert.equal(statSync(`${dest}.part`).size, half);
});

test("a connection that stalls mid-body is cut after the idle timeout, keeps its .part and resumes later", async () => {
  const half = Math.floor(payload.length / 2);
  const host = serve({ supportsRange: true, stallAfter: half });
  const dest = scratch();
  try {
    const started = Date.now();
    await assert.rejects(downloadVerified(host.url, dest, { sha256 }, undefined, fetch, 300), (error: unknown) => error instanceof DownloadError && error.kind === "stalled");
    assert.ok(Date.now() - started < 3_000, "the idle timeout fires");
    assert.equal(statSync(`${dest}.part`).size, half);
    await downloadVerified(host.url, dest, { sha256 }, undefined, fetch, 300);
    assert.deepEqual(readFileSync(dest), payload);
  } finally {
    host.stop();
  }
});

test("a server that sends nothing at all is cut after the idle timeout", async () => {
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/file`;
    await assert.rejects(downloadVerified(url, scratch(), { sha256 }, undefined, fetch, 300), (error: unknown) => error instanceof DownloadError && error.kind === "stalled");
  } finally {
    silent.closeAllConnections();
    silent.close();
  }
});

test("the hint names the next action for each cause of a failed download", () => {
  const locked = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  assert.match(downloadFailureHint(locked), /mine-ai stop/u);
  assert.match(downloadFailureHint(new DownloadError("x", "checksum")), /checksum.*deleted|newest Mine AI release/su);
  assert.match(downloadFailureHint(new DownloadError("x", "http")), /answered with an error/u);
  for (const kind of ["incomplete", "stalled", "network"] as const) assert.match(downloadFailureHint(new DownloadError("x", kind)), /continues where it stopped/u);
  assert.match(downloadFailureHint(new TypeError("fetch failed")), /internet connection/u);
});

test("a download that cannot connect names the file and the host, never the query string", async () => {
  const refusing = (async () => {
    throw new Error("Unable to connect. Is the computer able to access the url?");
  }) as unknown as typeof fetch;
  const dest = join(mkdtempSync(join(tmpdir(), "download-")), "server.jar");
  await assert.rejects(downloadVerified("https://piston-data.mojang.com/v1/objects/abc/server.jar?token=SECRET", dest, { sha1 }, undefined, refusing), (error: unknown) => {
    assert.ok(error instanceof DownloadError && error.kind === "network");
    assert.match(error.message, /server\.jar/u);
    assert.match(error.message, /piston-data\.mojang\.com/u);
    assert.match(error.message, /Unable to connect/u);
    assert.doesNotMatch(error.message, /SECRET|token|\/v1\/objects/u);
    return true;
  });
});

test("a download cut by Bun shows the cause without Bun's 'pass verbose: true' hint", async () => {
  const cut = (async () => {
    throw new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
  }) as unknown as typeof fetch;
  const dest = join(mkdtempSync(join(tmpdir(), "download-")), "server.jar");
  await assert.rejects(downloadVerified("https://piston-data.mojang.com/v1/objects/abc/server.jar", dest, { sha1 }, undefined, cut), (error: unknown) => {
    assert.ok(error instanceof DownloadError);
    assert.equal(error.message, "Cannot download server.jar from piston-data.mojang.com: The socket connection was closed unexpectedly.");
    return true;
  });
});

test("a body cut by the network names the file and the host too, and keeps the .part", async () => {
  const dest = join(mkdtempSync(join(tmpdir(), "download-")), "OllamaSetup.exe");
  let sent = false;
  const failing = (async () => {
    const stream = new ReadableStream({
      pull(controller) {
        if (sent) return controller.error(new Error("connection reset"));
        sent = true;
        controller.enqueue(payload.subarray(0, 500));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-length": String(payload.length) } });
  }) as unknown as typeof fetch;
  await assert.rejects(downloadVerified("https://ollama.com/download/OllamaSetup.exe", dest, { sha256 }, undefined, failing), /OllamaSetup\.exe.*ollama\.com.*connection reset/su);
  assert.equal(statSync(`${dest}.part`).size, 500);
});

/** A fetch answering 200 with `payload` as a stream; `cancelled()` says whether the caller cancelled the body, `contentLength: false` sends none (chunked). */
function streamedPayload(options: { contentLength?: boolean } = {}): { fetchImpl: typeof fetch; cancelled(): boolean } {
  let cancelled = false;
  const fetchImpl = (async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, { status: 200, headers: options.contentLength === false ? {} : { "content-length": String(payload.length) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, cancelled: () => cancelled };
}

test("beforeBody gets the whole file's size and where the body starts (0, or the bytes a resumed .part holds), before a byte of a fresh download is written", async () => {
  for (const [resumeFrom, startsAt] of [[0, 0], [1000, 1000]]) {
    const host = serve({ supportsRange: true });
    const dest = scratch();
    if (resumeFrom > 0) writeFileSync(`${dest}.part`, payload.subarray(0, resumeFrom));
    const calls: [number, number][] = [];
    try {
      await downloadVerified(host.url, dest, { sha256 }, undefined, undefined, undefined, {
        beforeBody: (total, from) => {
          calls.push([total, from]);
          if (resumeFrom === 0) assert.equal(existsSync(`${dest}.part`), false, "nothing written yet");
        },
      });
      assert.deepEqual(calls, [[payload.length, startsAt]]);
      assert.deepEqual(readFileSync(dest), payload);
    } finally {
      host.stop();
    }
  }
});

test("a beforeBody that throws cancels the body, writes nothing, keeps the .part as it was and passes its error on", async () => {
  const dest = scratch();
  writeFileSync(`${dest}.part`, "earlier part");
  const { fetchImpl, cancelled } = streamedPayload();
  const stop = new Error("not enough space");
  await assert.rejects(
    downloadVerified("https://example.test/file", dest, { sha256 }, undefined, fetchImpl, undefined, { beforeBody: async () => { throw stop; } }),
    (error: unknown) => error === stop,
  );
  assert.equal(cancelled(), true);
  assert.equal(readFileSync(`${dest}.part`, "utf8"), "earlier part");
  assert.equal(existsSync(dest), false);
});

test("a beforeBody error reaches the step even when the body had already failed: the player reads the disk text, not the network's", async () => {
  let body!: ReadableStreamDefaultController;
  const failedBody = (async () => new Response(new ReadableStream({ start: (controller) => void (body = controller) }), { status: 200, headers: { "content-length": String(payload.length) } })) as unknown as typeof fetch;
  const stop = new Error("not enough space");
  await assert.rejects(
    downloadVerified("https://example.test/file", scratch(), { sha256 }, undefined, failedBody, undefined, { beforeBody: async () => { body.error(new Error("connection reset")); throw stop; } }),
    (error: unknown) => error === stop,
  );
});

test("a download with no Content-Length does not call beforeBody and goes on", async () => {
  const dest = scratch();
  const { fetchImpl } = streamedPayload({ contentLength: false });
  let called = false;
  await downloadVerified("https://example.test/file", dest, { sha256 }, undefined, fetchImpl, undefined, { beforeBody: () => void (called = true) });
  assert.equal(called, false);
  assert.deepEqual(readFileSync(dest), payload);
});

test("a dest that already has the right hash makes no request and does not call beforeBody", async () => {
  const dest = scratch();
  writeFileSync(dest, payload);
  let called = false;
  const neverCalled = (async () => { throw new Error("no request expected"); }) as unknown as typeof fetch;
  await downloadVerified("https://example.test/file", dest, { sha256 }, undefined, neverCalled, undefined, { beforeBody: () => void (called = true) });
  assert.equal(called, false);
});
