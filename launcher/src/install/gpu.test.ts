import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assessGpu, chooseModel, gpu, parseOllamaCompute, parseRegistryVram, type ComputeDevice } from "./gpu.ts";
import { testContext, testManifest } from "./fixtures/install-test-support.ts";

const GIB = 1024 ** 3;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// Written in the same form as W1's recorded lines (`type=`/`total=`/`library=` fields) for devices the W1 machine
// lacks; the NVIDIA and Vulkan-only forms are unmeasured until a machine with them runs `ollama serve`.
const NVIDIA_LINE =
  'time=2026-10-30T10:00:00.000+01:00 level=INFO source=types.go:32 msg="inference compute" id=GPU-1234 filter_id=0 library=CUDA compute=8.9 name=CUDA0 description="NVIDIA GeForce RTX 4070" libdirs=ollama,cuda_v12 driver=12.8 pci_id=0000:01:00.0 type=discrete total="12.0 GiB" available="11.0 GiB"';
const VULKAN_LINE =
  'time=2026-10-30T10:00:00.000+01:00 level=INFO source=types.go:32 msg="inference compute" id=0 filter_id=0 library=Vulkan compute=0.0 name=Vulkan0 description="AMD Radeon RX 6700 XT" libdirs=ollama,vulkan driver=0.0 pci_id=0000:03:00.0 type=discrete total="12.0 GiB" available="11.7 GiB"';

const rocm: ComputeDevice = { library: "rocm", name: "AMD Radeon RX 7900 XTX", totalBytes: 24 * GIB, freeBytes: 23.8 * GIB };

test("registry fixture lists the three adapters of the W1 machine with their dedicated memory", () => {
  const adapters = parseRegistryVram(fixture("reg-vram.txt"));
  assert.deepEqual(
    adapters.map((a) => a.bytes),
    [0x20000000, 0x5ff000000, 0x20000000],
  );
});

test("registry parser reads the REG_BINARY little-endian form some drivers write", () => {
  const text = [
    "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000",
    "    HardwareInformation.qwMemorySize    REG_BINARY    0000000003000000",
  ].join("\r\n");
  // bytes 00 00 00 00 03 00 00 00, least significant first = 0x3_0000_0000 = 12 GiB
  assert.deepEqual(parseRegistryVram(text), [{ bytes: 12 * GIB }]);
});

test("registry parser gives no adapter for text without the memory value (reg failed or no GPU key)", () => {
  assert.deepEqual(parseRegistryVram("ERREUR : impossible de trouver la clé."), []);
  assert.deepEqual(parseRegistryVram(""), []);
});

test("compute parser keeps the ROCm card and ignores the dropped iGPU and ROCm lines of the W1 log", () => {
  const devices = parseOllamaCompute(fixture("ollama-serve-rocm-igpu-dropped.txt"));
  assert.equal(devices.length, 1);
  assert.equal(devices[0].library, "rocm");
  assert.equal(devices[0].name, "AMD Radeon RX 7900 XTX");
  assert.equal(devices[0].totalBytes, 24 * GIB);
  assert.equal(Math.round(devices[0].freeBytes / GIB * 10), 238);
});

test("compute parser reads CUDA, Vulkan and several devices, and skips a library it does not know", () => {
  const unknown = NVIDIA_LINE.replace("library=CUDA", "library=Quantum");
  const devices = parseOllamaCompute([NVIDIA_LINE, VULKAN_LINE, unknown].join("\n"));
  assert.deepEqual(
    devices.map((d) => [d.library, d.name, d.totalBytes]),
    [
      ["cuda", "NVIDIA GeForce RTX 4070", 12 * GIB],
      ["vulkan", "AMD Radeon RX 6700 XT", 12 * GIB],
    ],
  );
});

test("compute parser converts MiB and B units and gives nothing for a log without inference compute lines", () => {
  const small = NVIDIA_LINE.replace('total="12.0 GiB"', 'total="457.0 MiB"').replace('available="11.0 GiB"', 'available="0 B"');
  const [device] = parseOllamaCompute(small);
  assert.equal(device.totalBytes, 457 * 1024 ** 2);
  assert.equal(device.freeBytes, 0);
  assert.deepEqual(parseOllamaCompute('msg="discovering available GPUs..."'), []);
});

test("chooseModel stage 1: the registry's 24 GiB card with 64 GiB of RAM runs the local model", () => {
  const adapters = parseRegistryVram(fixture("reg-vram.txt"));
  assert.deepEqual(chooseModel(adapters, null, 64 * GIB, testManifest()), { kind: "local", model: "gemma4:12b" });
});

test("chooseModel stage 1: only iGPU-sized adapters (512 MiB) go remote and the reason names the VRAM minimum", () => {
  const choice = chooseModel([{ bytes: 0x20000000 }], null, 64 * GIB, testManifest());
  assert.equal(choice.kind, "remote");
  assert.match((choice as { reason: string }).reason, /10 GiB/);
});

test("chooseModel: no adapter at all goes remote", () => {
  assert.equal(chooseModel([], null, 64 * GIB, testManifest()).kind, "remote");
});

test("chooseModel stage 2: registry says 12 GiB but Ollama sees only the cpu goes remote", () => {
  const cpu: ComputeDevice = { library: "cpu", name: "cpu", totalBytes: 64 * GIB, freeBytes: 30 * GIB };
  const choice = chooseModel([{ bytes: 12 * GIB }], [cpu], 64 * GIB, testManifest());
  assert.equal(choice.kind, "remote");
  assert.match((choice as { reason: string }).reason, /Ollama/);
});

test("chooseModel stage 2: Ollama reporting no device at all goes remote", () => {
  assert.equal(chooseModel([{ bytes: 24 * GIB }], [], 64 * GIB, testManifest()).kind, "remote");
});

test("chooseModel stage 2: a ROCm card of 24 GiB runs the local model", () => {
  assert.equal(chooseModel([{ bytes: 24 * GIB }], [rocm], 64 * GIB, testManifest()).kind, "local");
});

test("chooseModel stage 2: free video memory counts (spec D4), so a 24 GiB card with 4 GiB free goes remote and the reason says free", () => {
  const busy: ComputeDevice = { ...rocm, freeBytes: 4 * GIB };
  const choice = chooseModel([{ bytes: 24 * GIB }], [busy], 64 * GIB, testManifest());
  assert.equal(choice.kind, "remote");
  assert.match((choice as { reason: string }).reason, /free/);
});

test("chooseModel stage 2: the largest device counts, so a small Vulkan card beside the cpu goes remote", () => {
  const small: ComputeDevice = { library: "vulkan", name: "small", totalBytes: 8 * GIB, freeBytes: 8 * GIB };
  const cpu: ComputeDevice = { library: "cpu", name: "cpu", totalBytes: 64 * GIB, freeBytes: 30 * GIB };
  assert.equal(chooseModel([{ bytes: 24 * GIB }], [cpu, small], 64 * GIB, testManifest()).kind, "remote");
});

test("chooseModel: VRAM ok but 16 GiB of RAM with minRamGiB 32 goes remote and the reason names the RAM", () => {
  const choice = chooseModel([{ bytes: 24 * GIB }], [rocm], 16 * GIB, testManifest());
  assert.equal(choice.kind, "remote");
  assert.match((choice as { reason: string }).reason, /32 GiB/);
});

test("chooseModel: another threshold in the manifest changes the answer", () => {
  const adapters = [{ bytes: 12 * GIB }];
  assert.equal(chooseModel(adapters, null, 64 * GIB, testManifest()).kind, "local");
  assert.equal(chooseModel(adapters, null, 64 * GIB, testManifest({ minVramGiB: 16 })).kind, "remote");
  assert.equal(chooseModel(adapters, null, 24 * GIB, testManifest({ minRamGiB: 16 })).kind, "local");
});

test("gpu step reports the adapters, the RAM and the choice, and writes nothing", async () => {
  const ctx = testContext("unused-root");
  const result = await gpu(ctx, { readRegistry: async () => fixture("reg-vram.txt"), totalRamBytes: () => 64 * GIB });
  assert.equal(result.ok, true);
  assert.equal(result.report.choice.kind, "local");
  assert.equal(result.report.adapters.length, 3);
  assert.equal(result.report.ramBytes, 64 * GIB);
  assert.equal(result.report.compute, null);
});

test("gpu step: a registry that cannot be read is a remote answer with the cause, not a crash", async () => {
  const ctx = testContext("unused-root");
  const result = await gpu(ctx, {
    readRegistry: async () => {
      throw new Error("reg.exe not found");
    },
    totalRamBytes: () => 64 * GIB,
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.choice.kind, "remote");
  assert.match((result.report.choice as { reason: string }).reason, /reg\.exe not found/);
});

test("every remote verdict gives the facts as the reason and the next action as the hint, so the installer shows one sentence each", async () => {
  const remote = (choice: ReturnType<typeof chooseModel>) => {
    assert.equal(choice.kind, "remote");
    return choice as { reason: string; hint: string };
  };
  const lowVram = remote(chooseModel([{ bytes: 0x20000000 }], null, 64 * GIB, testManifest()));
  const lowRam = remote(chooseModel([{ bytes: 24 * GIB }], [rocm], 16 * GIB, testManifest()));
  const unreadable = (await assessGpu(null, testManifest(), { readRegistry: async () => { throw new Error("Command failed: reg.exe query"); }, totalRamBytes: () => 64 * GIB })).choice;
  for (const verdict of [lowVram, lowRam, remote(unreadable)]) {
    assert.doesNotMatch(verdict.reason, /remote endpoint/u, "the next action is the hint's job");
    assert.match(verdict.hint, /remote endpoint/u);
    assert.match(verdict.hint, /URL.*key.*model/su, "the hint says what the endpoint needs");
  }
  assert.doesNotMatch(lowVram.hint, /Close programs/u, "stage 1 reads the card's total memory: closing programs changes nothing");
  const busyGpu = remote(chooseModel([{ bytes: 24 * GIB }], [{ ...rocm, freeBytes: 4 * GIB }], 64 * GIB, testManifest()));
  assert.match(busyGpu.hint, /Close programs.*run the installer again/u, "stage 2 measures free memory: closing programs helps, and the check runs again with the installer");
});
