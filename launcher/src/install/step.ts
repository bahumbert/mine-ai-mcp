/** What every install step takes and returns, so `mine-ai install <step>` and the installer treat all steps alike. */
import type { Manifest } from "../manifest.ts";
import type { Settings } from "../settings.ts";

export interface InstallContext {
  readonly manifest: Manifest;
  readonly settings: Settings;
  /** The data root (`dataRoot()`): `runtime/`, `server/`, `logs/` live under it. */
  readonly root: string;
  /** `fraction` 0..1 of the whole step. */
  onProgress(fraction: number, label: string): void;
}

/**
 * What a step says when it corrected the player's input on its own (owner 2026-11-06, memory `show-auto-corrections`: a
 * correction is always told): the new value and the sentence to show. The installer puts `correctedUrl` in its box and
 * shows `notice`; the same sentence also starts `detail` or `error`, which is all the command line prints.
 */
export interface InputCorrection {
  readonly correctedUrl?: string;
  readonly notice?: string;
}

export type StepResult = InputCorrection & ({ readonly ok: true; readonly detail: string } | { readonly ok: false; readonly error: string; readonly hint: string });

/** The failed side of `StepResult`: what steps return from a helper that can only fail. */
export type StepFailure = Extract<StepResult, { readonly ok: false }>;

/** A failed step with the message and the next action as written (`stepFailure` takes a thrown error). */
export function failure(error: string, hint: string): StepFailure {
  return { ok: false, error, hint };
}

/** A Windows file another program holds open (a running server's `java.exe`, an antivirus scan): EBUSY, EPERM or EACCES. */
export function isFileLockError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/** The next action after `isFileLockError`: the files are free once the stack is stopped. */
export const FILE_LOCKED_HINT = "Another program holds the file (a running Mine AI server or an antivirus): run `mine-ai stop`, wait a few seconds and run this step again.";

/** A failed step: the thrown error's message as `error`, and what the user can do next as `hint`. */
export function stepFailure(error: unknown, hint: string): StepResult {
  return failure(error instanceof Error ? error.message : String(error), hint);
}
