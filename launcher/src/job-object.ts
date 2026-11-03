import { dlopen, FFIType, ptr } from "bun:ffi";

/** JOBOBJECTINFOCLASS JobObjectExtendedLimitInformation. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64; `BasicLimitInformation.LimitFlags` sits at offset 16. */
const EXTENDED_LIMIT_INFORMATION_BYTES = 144;
const LIMIT_FLAGS_OFFSET = 16;

/**
 * Puts this process in a Windows job object that kills every process in it when the job closes, i.e. when this
 * process ends for any reason (Task Manager included). Children spawned afterwards inherit the job, so a launcher
 * killed from outside takes its hosts, Java and Ollama with it (installer spike W1, facts `packaging.md` "Process
 * lifetime"). No breakaway flag: a child cannot leave the job.
 *
 * Returns `false` and does nothing off Windows; returns `true` once attached; throws with the Win32 error code when
 * Windows refuses, so the caller can say the safety net is missing.
 */
export function attachKillOnClose(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const kernel32 = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
    SetInformationJobObject: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    AssignProcessToJobObject: { args: [FFIType.i64, FFIType.i64], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.i64 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
  const job = kernel32.CreateJobObjectW(null, null);
  if (job === 0n) throw new Error(`CreateJobObjectW failed (Win32 error ${kernel32.GetLastError()})`);
  const info = new ArrayBuffer(EXTENDED_LIMIT_INFORMATION_BYTES);
  new DataView(info).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (kernel32.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(info), EXTENDED_LIMIT_INFORMATION_BYTES) === 0) {
    throw new Error(`SetInformationJobObject failed (Win32 error ${kernel32.GetLastError()})`);
  }
  if (kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()) === 0) {
    throw new Error(`AssignProcessToJobObject failed (Win32 error ${kernel32.GetLastError()})`);
  }
  // The job handle is never closed: the process ending closes it, and that kills the job's processes.
  return true;
}
