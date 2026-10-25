// The files of one trial: its log (client.log, as Mine Labs writes it) and its results.json.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeRunResult, type RunResult } from "mine-labs";

export interface RunLog {
  readonly log: (message: string) => void;
  /** Resolves once every line is on disk. */
  readonly close: () => Promise<void>;
}

export interface RunIo {
  open(runDir: string): Promise<RunLog>;
  writeResult(runDir: string, result: RunResult): Promise<void>;
}

export const fileRunIo: RunIo = {
  async open(runDir) {
    await mkdir(runDir, { recursive: true });
    const path = join(runDir, "client.log");
    let tail = Promise.resolve();
    return {
      log: message => { tail = tail.then(() => appendFile(path, `${new Date().toISOString()} ${message}\n`)).catch(() => undefined); },
      close: () => tail,
    };
  },
  writeResult: (runDir, result) => writeRunResult(runDir, result),
};
