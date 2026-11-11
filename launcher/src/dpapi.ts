// The API key's encryption for the current Windows user: DPAPI `CryptProtectData` / `CryptUnprotectData` through `bun:ffi`
// (plan 2026-11-06-installer-improvements T2, spec D3). Measured with `.agent/scripts/installer/launcher-probes/dpapi-key.ts`
// on Windows Bun 1.4.2: round trips exact, an empty input fails (error 87: callers never pass one), a changed byte fails
// (error 13), 6 calls in 5.6 ms. Only the blob packing is pure; the calls need Windows, so only a Windows run proves them.
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

/** What `secret.ts` needs from an encryption: bytes in, bytes out. A fake stands in for it off Windows. */
export interface KeyCipher {
  protect(clear: Uint8Array): Uint8Array;
  unprotect(blob: Uint8Array): Uint8Array;
}

/** `CRYPTPROTECT_UI_FORBIDDEN`: a failure returns an error instead of opening a window. */
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
/** The blob is bound to this text too: another program's blob does not decrypt here. */
const ENTROPY = new TextEncoder().encode("mine-ai settings llm.apiKey");

/** A Windows DATA_BLOB on x64: u32 length at 0, 4 bytes of padding, u64 pointer at 8. */
export function packDataBlob(length: number, pointer: bigint | number): Uint8Array {
  const blob = new Uint8Array(16);
  const view = new DataView(blob.buffer);
  view.setUint32(0, length, true);
  view.setBigUint64(8, BigInt(pointer), true);
  return blob;
}

/** The blob describing `bytes`; `bytes` must stay referenced until the call that reads the blob has returned. */
const blobOf = (bytes: Uint8Array): Uint8Array => packDataBlob(bytes.length, bytes.length === 0 ? 0 : ptr(bytes));

interface Win32 {
  crypt32: ReturnType<typeof loadCrypt32>;
  kernel32: ReturnType<typeof loadKernel32>;
}

const loadCrypt32 = () =>
  dlopen("crypt32.dll", {
    CryptProtectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CryptUnprotectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
const loadKernel32 = () => dlopen("kernel32.dll", { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr }, GetLastError: { args: [], returns: FFIType.u32 } });

/** Copies the bytes Windows allocated for an output blob, then frees them with `LocalFree`. */
function takeOutput(kernel32: Win32["kernel32"], out: Uint8Array): Uint8Array {
  const view = new DataView(out.buffer);
  const length = view.getUint32(0, true);
  const pointer = Number(view.getBigUint64(8, true));
  const copy = length === 0 ? new Uint8Array(0) : new Uint8Array(toArrayBuffer(pointer as never, 0, length)).slice();
  if (pointer !== 0) kernel32.symbols.LocalFree(pointer as never);
  return copy;
}

/**
 * The real cipher: DPAPI, current-user scope. Throws `Error("<call> failed (error <GetLastError>)")` when Windows refuses.
 * The DLLs open at the first call, so making a cipher costs nothing for the many loads of a settings file that hold no key.
 */
export function dpapiCipher(): KeyCipher {
  let loaded: Win32 | null = null;
  const run = (call: "CryptProtectData" | "CryptUnprotectData", input: Uint8Array): Uint8Array => {
    const win32 = (loaded ??= { crypt32: loadCrypt32(), kernel32: loadKernel32() });
    const inputBlob = blobOf(input);
    const entropyBlob = blobOf(ENTROPY);
    const out = new Uint8Array(16);
    const ok = win32.crypt32.symbols[call](ptr(inputBlob), null, ptr(entropyBlob), null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(out));
    if (!ok) throw new Error(`${call} failed (error ${win32.kernel32.symbols.GetLastError()})`);
    return takeOutput(win32.kernel32, out);
  };
  return { protect: (clear) => run("CryptProtectData", clear), unprotect: (blob) => run("CryptUnprotectData", blob) };
}
