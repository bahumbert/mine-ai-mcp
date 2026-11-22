// A stand-in for DPAPI in tests off Windows: XOR with a tag, a magic byte and a counter in front so every blob differs, as
// DPAPI's output does on each call (measured 2026-11-06, `dpapi.ts`). It refuses what DPAPI refused in the probe: an empty
// input (error 87) and bytes that are no blob (error 13/87). Windows Bun tests use the real cipher instead.
import type { KeyCipher } from "./dpapi.ts";

const TAG = 0x5a;
const MAGIC = 0xd0;

export interface CountingCipher extends KeyCipher {
  protectCalls: number;
  unprotectCalls: number;
}

export function fakeKeyCipher(): CountingCipher {
  const cipher: CountingCipher = {
    protectCalls: 0,
    unprotectCalls: 0,
    protect(clear) {
      cipher.protectCalls++;
      if (clear.length === 0) throw new Error("CryptProtectData failed (error 87)");
      return Uint8Array.from([MAGIC, cipher.protectCalls, ...clear.map((byte) => byte ^ TAG)]);
    },
    unprotect(blob) {
      cipher.unprotectCalls++;
      if (blob.length < 3 || blob[0] !== MAGIC) throw new Error("CryptUnprotectData failed (error 13)");
      return blob.slice(2).map((byte) => byte ^ TAG);
    },
  };
  return cipher;
}

/** The base64 blob `fakeKeyCipher` writes for `clear`, as settings.json would hold it. */
export const fakeBlobOf = (clear: string, cipher: KeyCipher = fakeKeyCipher()): string => Buffer.from(cipher.protect(new TextEncoder().encode(clear))).toString("base64");

/** A cipher whose `unprotect` always fails, as DPAPI does for a blob of another user or PC; `protect` must not be called. */
export const unreadingCipher: KeyCipher = {
  protect: () => {
    throw new Error("protect must not be called");
  },
  unprotect: () => {
    throw new Error("CryptUnprotectData failed (error 13)");
  },
};
