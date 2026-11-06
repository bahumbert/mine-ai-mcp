// The remote model's API key between settings.json and memory (plan 2026-11-06-installer-improvements T2, spec D3):
// pure functions over a `KeyCipher`, so every rule is tested without Windows. `null` is "no cipher here" (Linux, macOS).
import type { KeyCipher } from "./dpapi.ts";

interface RemoteLlmBase {
  kind: "remote";
  baseUrl: string;
  model: string;
  /** A key this version does not know is kept on save, as everywhere in the settings. */
  [key: string]: unknown;
}
/** A remote `llm` as settings.json holds it: the key is clear (`apiKey`) or encrypted (`apiKeyProtected`), or both absent. */
interface RemoteLlmFile extends RemoteLlmBase {
  apiKey?: string;
  apiKeyProtected?: string;
}
/** A remote `llm` in memory: the clear key always set; the fields after it are helpers that are never written to the file. */
export interface RemoteLlmInMemory extends RemoteLlmBase {
  apiKey: string;
  /** The blob as read from the file. */
  apiKeyProtected?: string;
  /** The key the blob decrypted to when loaded: a save of the same key reuses the blob instead of making a new one. */
  loadedKey?: string;
  /** The file held a blob this PC or user cannot decrypt; `apiKey` is empty and the blob must survive any save. */
  keyUnreadable?: boolean;
  /** The file held a non-empty clear key where a cipher exists: the next save encrypts it, and the player is told. */
  clearKeyInFile?: boolean;
}
interface LocalLlm {
  kind: "local";
  model: string;
  [key: string]: unknown;
}
type LlmInFile = LocalLlm | RemoteLlmFile;
type LlmInMemory = LocalLlm | RemoteLlmInMemory;

/** The key fields a loaded remote `llm` takes. Absent helpers are absent, not `undefined`. */
type LoadedKey = Pick<RemoteLlmInMemory, "apiKey" | "apiKeyProtected" | "loadedKey" | "keyUnreadable" | "clearKeyInFile">;

/** The clear key a blob holds, or null when there is no cipher or the blob does not decrypt (another user or PC, a damaged file). */
function decryptBlob(blob: string, cipher: KeyCipher | null): string | null {
  if (cipher === null) return null;
  try {
    const bytes = Buffer.from(blob, "base64");
    if (bytes.length === 0) return null; // text that is no base64: DPAPI refuses an empty input (error 87), so it is never asked
    return new TextDecoder().decode(cipher.unprotect(bytes));
  } catch {
    return null;
  }
}

/** The key of a file's remote `llm` for memory. Never throws: a blob that does not decrypt gives `keyUnreadable`. */
export function readRemoteKey(file: { apiKey?: string; apiKeyProtected?: string }, cipher: KeyCipher | null): LoadedKey {
  const blob = file.apiKeyProtected ?? "";
  const clear = file.apiKey ?? "";
  if (blob !== "") {
    const key = decryptBlob(blob, cipher);
    if (key !== null) return { apiKey: key, apiKeyProtected: blob, loadedKey: key };
    if (clear === "") return { apiKey: "", apiKeyProtected: blob, keyUnreadable: true };
  }
  if (clear === "") return { apiKey: "" };
  return cipher === null ? { apiKey: clear } : { apiKey: clear, clearKeyInFile: true };
}

/** The in-memory `llm` for one read from the file. Helper fields a hand-edited file might hold are dropped; the loaded ones replace them. */
export function llmFromFile(llm: LlmInFile, cipher: KeyCipher | null): LlmInMemory {
  if (llm.kind === "local") return llm;
  const { apiKey, apiKeyProtected, loadedKey, keyUnreadable, clearKeyInFile, ...rest } = llm;
  return { ...rest, ...readRemoteKey({ apiKey, apiKeyProtected }, cipher) };
}

/**
 * The `llm` to write to settings.json: with a cipher a non-empty key becomes `apiKeyProtected` and no clear `apiKey`
 * (the blob read is kept when the key is the one loaded: DPAPI's output differs on every call); an empty key is
 * `apiKey: ""` (DPAPI refuses an empty input); an unreadable key keeps its blob; without a cipher the key stays in clear.
 * The helper fields are dropped.
 */
export function llmForFile(llm: LlmInMemory, cipher: KeyCipher | null): LlmInFile {
  if (llm.kind === "local") return llm;
  const { apiKey, apiKeyProtected, loadedKey, keyUnreadable, clearKeyInFile, ...rest } = llm;
  if (keyUnreadable === true && apiKeyProtected !== undefined) return { ...rest, apiKeyProtected };
  if (apiKey === "" || cipher === null) return { ...rest, apiKey };
  if (apiKeyProtected !== undefined && loadedKey === apiKey) return { ...rest, apiKeyProtected };
  return { ...rest, apiKeyProtected: Buffer.from(cipher.protect(new TextEncoder().encode(apiKey))).toString("base64") };
}

/** The line said once after a clear key was encrypted (owner rule: an automatic change is told). */
export const keyMigrationLine = (settingsFile: string, windowsUser: string): string =>
  `The API key in ${settingsFile} is now encrypted for the Windows user ${windowsUser}; it no longer appears in clear in the file.`;

/** Why `mine-ai start` stops when the saved key cannot be decrypted. */
export const keyUnreadableStartText = (settingsFile: string): string =>
  `The API key in ${settingsFile} was saved by another Windows user or on another PC and cannot be read here. Enter it again: run the Mine AI setup again, or mine-ai configure --llm-remote <url> <key> <model>.`;
