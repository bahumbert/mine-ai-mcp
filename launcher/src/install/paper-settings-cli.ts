/**
 * `bun paper-settings-cli.ts <serverDir> [<settings.json>]`: applies Paper's settings to a server folder, prints each
 * changed key on its own line, then `paper settings <digest>`, and writes the digest to `<serverDir>/.paper-settings-digest`.
 * `--digest [<settings.json>]` prints only the digest and writes nothing. Exit 1 with the error text on a refusal.
 * Default settings file: `packaging/paper-settings.json` of this repository.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPaperSettings, loadPaperSettings, paperSettingsDigest } from "./paper-settings.ts";

const USAGE = "usage: bun paper-settings-cli.ts <serverDir> [<settings.json>]  |  --digest [<settings.json>]";
const defaultSettingsPath = join(import.meta.dir, "..", "..", "..", "packaging", "paper-settings.json");

async function main(args: string[]): Promise<void> {
  if (args[0] === "--digest") {
    console.log(paperSettingsDigest(loadPaperSettings(args[1] ?? defaultSettingsPath)));
    return;
  }
  const [serverDir, settingsPath] = args;
  if (!serverDir || serverDir.startsWith("--")) throw new Error(USAGE);
  const settings = loadPaperSettings(settingsPath ?? defaultSettingsPath);
  const changed = await applyPaperSettings(serverDir, settings);
  const digest = paperSettingsDigest(settings);
  writeFileSync(join(serverDir, ".paper-settings-digest"), `${digest}\n`);
  for (const line of changed) console.log(line);
  console.log(`paper settings ${digest}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
