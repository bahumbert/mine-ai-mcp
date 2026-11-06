import assert from "node:assert/strict";
import test from "node:test";
import { fakeBlobOf as blobOf, fakeKeyCipher as fakeCipher, unreadingCipher as throwingCipher } from "./key-cipher-test-support.ts";
import { llmForFile, readRemoteKey, type RemoteLlmInMemory } from "./secret.ts";

const remote = (extra: Partial<RemoteLlmInMemory> = {}): RemoteLlmInMemory => ({ kind: "remote", baseUrl: "https://api.test/v1", model: "m", apiKey: "sk-secret", ...extra });

test("readRemoteKey: no key, an empty key or an empty blob string give an empty key and never call the cipher", () => {
  const cipher = fakeCipher();
  assert.deepEqual(readRemoteKey({}, cipher), { apiKey: "" });
  assert.deepEqual(readRemoteKey({ apiKey: "" }, cipher), { apiKey: "" });
  assert.deepEqual(readRemoteKey({ apiKey: "", apiKeyProtected: "" }, cipher), { apiKey: "" });
  assert.equal(cipher.unprotectCalls + cipher.protectCalls, 0);
});

test("readRemoteKey: a blob is decrypted and kept as read, with the key it held", () => {
  const cipher = fakeCipher();
  const blob = blobOf("sk-secret", cipher);
  assert.deepEqual(readRemoteKey({ apiKeyProtected: blob }, cipher), { apiKey: "sk-secret", apiKeyProtected: blob, loadedKey: "sk-secret" });
});

test("readRemoteKey: a clear key where a cipher exists is flagged for encryption; without a cipher it is the normal form", () => {
  assert.deepEqual(readRemoteKey({ apiKey: "sk-old" }, fakeCipher()), { apiKey: "sk-old", clearKeyInFile: true });
  assert.deepEqual(readRemoteKey({ apiKey: "sk-old" }, null), { apiKey: "sk-old" });
});

test("readRemoteKey: a blob that does not decrypt, or that no cipher is there to read (a Windows file on Linux), gives no key, keyUnreadable and the blob; it never throws", () => {
  const unreadable = { apiKey: "", apiKeyProtected: "AAAA", keyUnreadable: true };
  assert.deepEqual(readRemoteKey({ apiKeyProtected: "AAAA" }, throwingCipher), unreadable);
  assert.deepEqual(readRemoteKey({ apiKeyProtected: "AAAA" }, null), unreadable);
});

test("readRemoteKey: blob text that is no base64 is unreadable and never reaches the cipher, which refuses an empty input", () => {
  const cipher = fakeCipher();
  assert.deepEqual(readRemoteKey({ apiKeyProtected: "!!!" }, cipher), { apiKey: "", apiKeyProtected: "!!!", keyUnreadable: true });
  assert.equal(cipher.unprotectCalls, 0);
});

test("llmForFile: with a cipher a non-empty key is written as a blob only, and no clear key stays", () => {
  const cipher = fakeCipher();
  const written = llmForFile(remote(), cipher);
  assert.equal("apiKey" in written, false);
  assert.equal(written.kind === "remote" && written.apiKeyProtected, blobOf("sk-secret", fakeCipher()));
  assert.equal(JSON.stringify(written).includes("sk-secret"), false);
});

test("llmForFile: an empty key is written as apiKey \"\" and the cipher is never called", () => {
  const cipher = fakeCipher();
  assert.deepEqual(llmForFile(remote({ apiKey: "" }), cipher), { kind: "remote", baseUrl: "https://api.test/v1", model: "m", apiKey: "" });
  assert.equal(cipher.protectCalls, 0);
});

test("llmForFile: a key that was not changed is written with the blob it was loaded with, byte for byte", () => {
  const cipher = fakeCipher();
  const blob = blobOf("sk-secret", cipher);
  const loaded = remote({ apiKeyProtected: blob, loadedKey: "sk-secret" });
  const callsBefore = cipher.protectCalls;
  assert.equal((llmForFile({ ...loaded, baseUrl: "https://other.test/v1" }, cipher) as { apiKeyProtected: string }).apiKeyProtected, blob);
  assert.equal(cipher.protectCalls, callsBefore);
});

test("llmForFile: a changed key gets a new blob", () => {
  const cipher = fakeCipher();
  const blob = blobOf("sk-secret", cipher);
  const written = llmForFile(remote({ apiKey: "sk-new", apiKeyProtected: blob, loadedKey: "sk-secret" }), cipher) as { apiKeyProtected: string };
  assert.notEqual(written.apiKeyProtected, blob);
  assert.equal(new TextDecoder().decode(cipher.unprotect(Buffer.from(written.apiKeyProtected, "base64"))), "sk-new");
});

test("llmForFile: without a cipher (Linux) the key stays in clear and no helper field reaches the file", () => {
  const written = llmForFile(remote({ loadedKey: "sk-secret", clearKeyInFile: true }), null);
  assert.deepEqual(written, { kind: "remote", baseUrl: "https://api.test/v1", model: "m", apiKey: "sk-secret" });
});

test("llmForFile: an unreadable key is saved back as the same blob, with no apiKey and no helper field", () => {
  const written = llmForFile(remote({ apiKey: "", apiKeyProtected: "AAAA", keyUnreadable: true }), fakeCipher());
  assert.deepEqual(written, { kind: "remote", baseUrl: "https://api.test/v1", model: "m", apiKeyProtected: "AAAA" });
});

test("llmForFile: a local llm is untouched", () => {
  assert.deepEqual(llmForFile({ kind: "local", model: "gemma4:12b" }, fakeCipher()), { kind: "local", model: "gemma4:12b" });
});
