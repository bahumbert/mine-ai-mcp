// What the installer put on this PC (Ollama, a pulled model), so uninstall removes only what is ours.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const installStateSchema = z.looseObject({
  ollama: z.enum(["installed", "preexisting"]).optional(),
  modelPulledByUs: z.boolean().optional(),
  /** The `ollama.exe` of the Ollama we installed, wherever the player put it. */
  ollamaPath: z.string().optional(),
  /** Our model store (`OLLAMA_MODELS` of every serve of ours); absent: Ollama's default store. */
  ollamaModels: z.string().optional(),
});

export type InstallState = z.infer<typeof installStateSchema>;

function stateFile(root: string): string {
  return join(root, "install-state.json");
}

/** `{}` when the file is missing; a file that does not parse fails with its path and is never replaced. */
export function loadInstallState(root: string): InstallState {
  const file = stateFile(root);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return installStateSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`${file} is not a valid install state (${error instanceof Error ? error.message : String(error)}); fix it. Deleting it makes Mine AI forget the Ollama it installed and where its models are (a model already pulled is downloaded again).`);
  }
}

/** Writes through a temporary file so a crash never leaves half a record. Keys this version does not know are kept. */
export function saveInstallState(root: string, state: InstallState): void {
  const file = stateFile(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}
