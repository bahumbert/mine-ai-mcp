import assert from "node:assert/strict";
import test from "node:test";
import { checkUpdate, isNewerVersion, releaseVersion } from "./update-check.ts";

const LATEST_URL = "https://api.example.test/releases/latest";

function answering(body: unknown, status = 200): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

test("a newer release is reported with its page", async () => {
  const { fetchImpl, urls } = answering({ tag_name: "v1.3.0", html_url: "https://example.test/r/1.3.0" });
  const update = await checkUpdate("1.2.0", LATEST_URL, fetchImpl);
  assert.deepEqual(update, { latest: "1.3.0", url: "https://example.test/r/1.3.0" });
  assert.deepEqual(urls, [LATEST_URL]);
});

const offline = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

for (const [label, fetchImpl] of [
  ["the same release", answering({ tag_name: "v1.2.0" }).fetchImpl],
  ["an older release", answering({ tag_name: "1.1.9" }).fetchImpl],
  ["offline (and never throws)", offline],
  ["a body that is not the release JSON", answering("<html>rate limited</html>").fetchImpl],
  ["a tag that is not a version", answering({ tag_name: "nightly" }).fetchImpl],
  ["a 404 answer", answering({ message: "Not Found" }, 404).fetchImpl],
] as const) {
  test(`${label} reports nothing`, async () => {
    assert.equal(await checkUpdate("1.2.0", LATEST_URL, fetchImpl), null);
  });
}

test("with the check switched off nothing is requested", async () => {
  const { fetchImpl, urls } = answering({ tag_name: "v9.0.0" });
  assert.equal(await checkUpdate("1.2.0", LATEST_URL, fetchImpl, false), null);
  assert.deepEqual(urls, []);
});

test("versions compare number by number, not as text", () => {
  assert.equal(isNewerVersion("1.10.0", "1.9.0"), true);
  assert.equal(isNewerVersion("1.9.0", "1.10.0"), false);
  assert.equal(isNewerVersion("2.0", "1.9.9"), true);
});

test("a pre-alpha tag is read as its version", () => {
  assert.equal(releaseVersion("pre-alpha-0.2.0"), "0.2.0");
  assert.equal(releaseVersion("v1.3.0"), "1.3.0");
  assert.equal(releaseVersion("1.3.0"), "1.3.0");
  assert.equal(isNewerVersion("pre-alpha-0.2.0", "0.1.0"), true);
  assert.equal(isNewerVersion("pre-alpha-0.10.0", "0.9.0"), true);
  assert.equal(isNewerVersion("pre-alpha-0.1.0", "0.1.0"), false);
});

for (const tag of ["nightly", "pre-alpha-", "-0.2.0", "pre-alpha-0.2.0-rc1"]) {
  test(`the tag ${tag} is not a release version`, () => {
    assert.equal(releaseVersion(tag), null);
    assert.equal(isNewerVersion(tag, "0.1.0"), false);
  });
}

test("a newer pre-alpha release is reported with its version, not its tag", async () => {
  const { fetchImpl } = answering({ tag_name: "pre-alpha-0.2.0" });
  assert.deepEqual(await checkUpdate("0.1.0", LATEST_URL, fetchImpl), { latest: "0.2.0" });
});
