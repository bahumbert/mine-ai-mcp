import assert from "node:assert/strict";
import test from "node:test";
import { collectAdapters, decodeAdapterDesc1, DXGI_ADAPTER_DESC1_BYTES, type AdapterSlot } from "./dxgi.ts";
import { MEASURED_DXGI_ADAPTERS } from "./fixtures/install-test-support.ts";

const DXGI_ERROR_NOT_FOUND = 0x887a0002 | 0;
const DXGI_ERROR_DEVICE_REMOVED = 0x887a0005 | 0;
const SOFTWARE_FLAG = 2;

/** A DXGI_ADAPTER_DESC1 as GetDesc1 fills it (x64): Description[128] at 0, DedicatedVideoMemory at 272, Flags at 304. */
function desc1(name: string, dedicatedBytes: number | bigint, flags = 0): Uint8Array {
  const buffer = new Uint8Array(DXGI_ADAPTER_DESC1_BYTES);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < Math.min(name.length, 128); i++) view.setUint16(i * 2, name.charCodeAt(i), true);
  view.setBigUint64(272, BigInt(dedicatedBytes), true);
  view.setUint32(304, flags, true);
  return buffer;
}

// The four adapters measured on the owner's PC, 2026-11-06 (plan 2026-11-06-dxgi-gpu-detection).
const MEASURED_ROWS: Uint8Array[] = [
  desc1("AMD Radeon RX 7900 XTX", 25708240896n),
  desc1("AMD Radeon(TM) Graphics", 509374464),
  desc1("AMD Radeon RX 7900 XTX", 25708240896n),
  desc1("Microsoft Basic Render Driver", 0, SOFTWARE_FLAG),
];

const slotsFrom = (rows: AdapterSlot[]) => (index: number): AdapterSlot => rows[index] ?? { hr: DXGI_ERROR_NOT_FOUND, desc: null };
const ok = (desc: Uint8Array | null): AdapterSlot => ({ hr: 0, desc });

test("decodeAdapterDesc1 marks the SOFTWARE flag (the Microsoft Basic Render Driver), among other flag bits too", () => {
  assert.equal(decodeAdapterDesc1(desc1("Microsoft Basic Render Driver", 0, SOFTWARE_FLAG)).software, true);
  assert.equal(decodeAdapterDesc1(desc1("x", 0, SOFTWARE_FLAG | 1)).software, true, "other flag bits do not hide it");
});

test("decodeAdapterDesc1 reads a 127-character name whole and a 128-character one without a NUL as 128 characters", () => {
  const long127 = "a".repeat(127);
  const long128 = "b".repeat(128);
  assert.equal(decodeAdapterDesc1(desc1(long127, 1)).name, long127);
  const decoded = decodeAdapterDesc1(desc1(long128, 1));
  assert.equal(decoded.name, long128, "no read past byte 256, where VendorId starts");
  assert.equal(decoded.dedicatedBytes, 1);
});

test("decodeAdapterDesc1 refuses a buffer that is not 312 bytes", () => {
  assert.throws(() => decodeAdapterDesc1(new Uint8Array(311)), /DXGI adapter description is 311 bytes, expected 312/u);
});

test("collectAdapters decodes the four measured rows (memory above 2^32 exact, software one included) and stops at DXGI_ERROR_NOT_FOUND", () => {
  assert.deepEqual(collectAdapters(slotsFrom(MEASURED_ROWS.map(ok))), MEASURED_DXGI_ADAPTERS);
});

test("collectAdapters skips an adapter whose GetDesc1 failed and keeps the others", () => {
  const rows = [ok(MEASURED_ROWS[0]), ok(null), ok(MEASURED_ROWS[2]), ok(MEASURED_ROWS[3])];
  assert.equal(collectAdapters(slotsFrom(rows)).length, 3);
  assert.deepEqual(collectAdapters(slotsFrom(rows)).map((a) => a.dedicatedBytes), [25708240896, 25708240896, 0]);
});

test("collectAdapters keeps the adapters read when a later EnumAdapters1 fails", () => {
  const adapters = collectAdapters(slotsFrom([ok(MEASURED_ROWS[0]), { hr: DXGI_ERROR_DEVICE_REMOVED, desc: null }, ok(MEASURED_ROWS[2])]));
  assert.deepEqual(adapters.map((a) => a.name), ["AMD Radeon RX 7900 XTX"]);
});

test("collectAdapters throws the HRESULT when EnumAdapters1 fails before any adapter was read", () => {
  assert.throws(() => collectAdapters(slotsFrom([{ hr: DXGI_ERROR_DEVICE_REMOVED, desc: null }])), /EnumAdapters1 failed \(HRESULT 0x887a0005\)/u);
});

test("collectAdapters stops at 64 indexes when a driver never answers NOT_FOUND", () => {
  const asked: number[] = [];
  const adapters = collectAdapters((index) => {
    asked.push(index);
    return ok(MEASURED_ROWS[0]);
  });
  assert.equal(adapters.length, 64);
  assert.equal(asked.length, 64);
});
