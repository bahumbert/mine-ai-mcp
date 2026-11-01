import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dlopen, FFIType, ptr } from "bun:ffi";

/** One running process: what `cleanupStale` and the Ollama runner cleanup need to tell ours from another program's. */
export interface ProcessInfo {
  readonly pid: number;
  /** The pid of the process that started it; Windows keeps it after that parent has ended. */
  readonly parentPid: number;
  /** The executable's name as the system reports it (`bun.exe`, `java`): compare through `normalizeImageName`. */
  readonly image: string;
}
export type ProcessLister = () => Promise<readonly ProcessInfo[]>;

/** `C:\Tools\Bun.EXE` and `/usr/bin/bun` both become `bun`: the key recorded in `children.json` and compared later. */
export function normalizeImageName(image: string): string {
  const name = image.split(/[\\/]/u).pop() ?? image;
  return name.replace(/\.exe$/iu, "").toLowerCase();
}

/** The rows of `ps -eo pid=,ppid=,comm=`; a line that is not three columns is skipped. */
export function parsePsOutput(text: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match) processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), image: match[3]! });
  }
  return processes;
}

const TH32CS_SNAPPROCESS = 2;
/** PROCESSENTRY32W on x64: dwSize 0, th32ProcessID 8, th32ParentProcessID 32, szExeFile (260 UTF-16 units) 44; 568 bytes. */
const PROCESS_ENTRY_BYTES = 568;
const PID_OFFSET = 8;
const PARENT_PID_OFFSET = 32;
const EXE_FILE_OFFSET = 44;
const EXE_FILE_BYTES = 520;
const INVALID_HANDLE_VALUE = -1n;

/** The process table through the Toolhelp snapshot API: no child process, no PowerShell, and `wmic` (gone from recent Windows) is not needed. */
function listWindowsProcesses(): ProcessInfo[] {
  const kernel32 = dlopen("kernel32.dll", {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i64 },
    Process32FirstW: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
  const snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot === INVALID_HANDLE_VALUE) throw new Error(`CreateToolhelp32Snapshot failed (Win32 error ${kernel32.GetLastError()})`);
  try {
    const entry = new ArrayBuffer(PROCESS_ENTRY_BYTES);
    const view = new DataView(entry);
    view.setUint32(0, PROCESS_ENTRY_BYTES, true);
    const decoder = new TextDecoder("utf-16le");
    const processes: ProcessInfo[] = [];
    for (let more = kernel32.Process32FirstW(snapshot, ptr(entry)); more !== 0; more = kernel32.Process32NextW(snapshot, ptr(entry))) {
      const name = decoder.decode(new Uint8Array(entry, EXE_FILE_OFFSET, EXE_FILE_BYTES)).split("\0")[0]!;
      processes.push({ pid: view.getUint32(PID_OFFSET, true), parentPid: view.getUint32(PARENT_PID_OFFSET, true), image: name });
    }
    return processes;
  } finally {
    kernel32.CloseHandle(snapshot);
  }
}

/** Every running process with its parent pid: Toolhelp on Windows, `ps` elsewhere. */
export async function listProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcessInfo[]> {
  if (platform === "win32") return listWindowsProcesses();
  const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,comm="], { maxBuffer: 16 * 1024 * 1024 });
  return parsePsOutput(stdout);
}
