// The display adapters of this PC through DXGI (`bun:ffi`), instead of a child `reg.exe query` of the display class key:
// a scanner flagged the installer for "scanning hardware registry" (plan 2026-11-06-dxgi-gpu-detection, owner 2026-11-06).
// Measured with `.agent/scripts/installer/launcher-probes/dxgi-adapters.ts` (Windows Bun 1.4.2, three identical runs):
// RX 7900 XTX 25708240896 bytes, AMD Radeon(TM) Graphics 509374464, a second LUID of the 7900 XTX, and the Microsoft
// Basic Render Driver (flags 2, SOFTWARE). The decoding and the enumeration loop are pure and tested on those bytes;
// only `listDxgiAdapters` touches dxgi.dll, so only a Windows run proves it (the live check of the plan).
import { CFunction, dlopen, FFIType, ptr, read } from "bun:ffi";

/** sizeof(DXGI_ADAPTER_DESC1) on x64: 308 bytes of fields padded to 312. */
export const DXGI_ADAPTER_DESC1_BYTES = 312;
/** `DXGI_ERROR_NOT_FOUND` (0x887A0002) as the signed 32-bit value an `FFIType.i32` return gives: ends the enumeration. */
const DXGI_ERROR_NOT_FOUND = 0x887a0002 | 0;
const DXGI_ADAPTER_FLAG_SOFTWARE = 2;
/** Guards a driver that never answers NOT_FOUND. */
const MAX_ADAPTER_INDEX = 64;

// DXGI_ADAPTER_DESC1 offsets: `WCHAR Description[128]` (256 bytes) first, then four u32, then the sizes, the LUID, Flags.
const DESCRIPTION_BYTES = 256;
const DEDICATED_VIDEO_MEMORY_OFFSET = 272;
const FLAGS_OFFSET = 304;

// COM vtable slots: IUnknown::Release is 2; IDXGIAdapter1::GetDesc1 is 10; IDXGIFactory1::EnumAdapters1 is 12.
const RELEASE_SLOT = 2;
const GET_DESC1_SLOT = 10;
const ENUM_ADAPTERS1_SLOT = 12;

export type DxgiAdapter = { name: string; dedicatedBytes: number; software: boolean };
/** One `EnumAdapters1` answer: its HRESULT, and the 312 bytes of `GetDesc1` (null when `GetDesc1` failed). */
export type AdapterSlot = { hr: number; desc: Uint8Array | null };

/** Reads one DXGI_ADAPTER_DESC1 (little-endian, x64 layout). */
export function decodeAdapterDesc1(desc: Uint8Array): DxgiAdapter {
  if (desc.length !== DXGI_ADAPTER_DESC1_BYTES) throw new Error(`DXGI adapter description is ${desc.length} bytes, expected ${DXGI_ADAPTER_DESC1_BYTES}`);
  const view = new DataView(desc.buffer, desc.byteOffset, desc.byteLength);
  const name = new TextDecoder("utf-16le").decode(desc.subarray(0, DESCRIPTION_BYTES));
  const nul = name.indexOf("\0");
  return {
    name: nul === -1 ? name : name.slice(0, nul),
    dedicatedBytes: Number(view.getBigUint64(DEDICATED_VIDEO_MEMORY_OFFSET, true)),
    software: (view.getUint32(FLAGS_OFFSET, true) & DXGI_ADAPTER_FLAG_SOFTWARE) !== 0,
  };
}

const hresultText = (hr: number): string => (hr >>> 0).toString(16).padStart(8, "0");

/**
 * Asks `readSlot` for adapter 0, 1, 2... until NOT_FOUND. An adapter whose description could not be read is skipped;
 * any other enumeration failure stops the loop and keeps what was read, and throws only when nothing was.
 */
export function collectAdapters(readSlot: (index: number) => AdapterSlot): DxgiAdapter[] {
  const adapters: DxgiAdapter[] = [];
  for (let index = 0; index < MAX_ADAPTER_INDEX; index++) {
    const { hr, desc } = readSlot(index);
    if (hr === DXGI_ERROR_NOT_FOUND) break;
    if (hr !== 0) {
      if (adapters.length === 0) throw new Error(`EnumAdapters1 failed (HRESULT 0x${hresultText(hr)})`);
      break;
    }
    if (desc !== null) adapters.push(decodeAdapterDesc1(desc));
  }
  return adapters;
}

/** IID_IDXGIFactory1 {770aae78-f26f-4dba-a829-253c83d1b387}: Data1..Data3 little-endian, Data4 as written. */
function factoryIid(): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x770aae78, true);
  view.setUint16(4, 0xf26f, true);
  view.setUint16(6, 0x4dba, true);
  bytes.set([0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87], 8);
  return bytes;
}

/** The function at `slot` of a COM object's vtable. */
function comMethod(object: number, slot: number, args: FFIType[], returns: FFIType) {
  const vtable = read.ptr(object as never, 0);
  return CFunction({ ptr: read.ptr(vtable as never, slot * 8) as never, args, returns });
}

const releaseObject = (object: number): void => {
  comMethod(object, RELEASE_SLOT, [FFIType.ptr], FFIType.u32)(object);
};

/** `GetDesc1` of one adapter; the 8-byte aligned buffer is viewed as bytes. */
function readDescription(adapter: number): Uint8Array | null {
  const buffer = new BigUint64Array(DXGI_ADAPTER_DESC1_BYTES / 8);
  const hr = comMethod(adapter, GET_DESC1_SLOT, [FFIType.ptr, FFIType.ptr], FFIType.i32)(adapter, ptr(buffer));
  return hr === 0 ? new Uint8Array(buffer.buffer) : null;
}

/**
 * Every display adapter DXGI shows to this session, software ones included. Windows only; throws with the HRESULT when
 * the factory cannot be created or the first enumeration fails. The `dxgi.dll` handle is never closed: unloading it
 * after COM calls is unmeasured and a crash there cannot be caught (as `job-object.ts`).
 */
export function listDxgiAdapters(): DxgiAdapter[] {
  const dxgi = dlopen("dxgi.dll", { CreateDXGIFactory1: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
  const iid = factoryIid(); // a local, not a temporary inside the call: ptr() returns an address and does not own the buffer
  const factoryOut = new BigUint64Array(1);
  const hr = dxgi.symbols.CreateDXGIFactory1(ptr(iid), ptr(factoryOut));
  if (hr !== 0) throw new Error(`CreateDXGIFactory1 failed (HRESULT 0x${hresultText(hr)})`);
  const factory = Number(factoryOut[0]);
  try {
    const enumAdapters1 = comMethod(factory, ENUM_ADAPTERS1_SLOT, [FFIType.ptr, FFIType.u32, FFIType.ptr], FFIType.i32);
    return collectAdapters((index) => {
      const adapterOut = new BigUint64Array(1);
      const enumHr = enumAdapters1(factory, index, ptr(adapterOut));
      if (enumHr !== 0) return { hr: enumHr, desc: null };
      const adapter = Number(adapterOut[0]);
      try {
        return { hr: 0, desc: readDescription(adapter) };
      } finally {
        releaseObject(adapter);
      }
    });
  } finally {
    releaseObject(factory);
  }
}
