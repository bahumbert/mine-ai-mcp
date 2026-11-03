// What the daemon deletes from the template store (spec 2026-10-30-scenario-clients-ext4 D11 "Prune"): leftovers of dead builds, and templates nobody used for a week.
import { pruneStore, type ModulesPorts } from "./mirror-modules.ts";

/** A template that is not a current key and was not used for this long is deleted (spec D11). */
export const TEMPLATE_UNUSED_MAX_AGE_MS = 7 * 86_400_000;

/**
 * Deletes under `cacheDir`: every `*.tmp-<pid>` whose process is gone (`<key>.tmp-` a build's copy, `build.tmp-` its server root, `probe.tmp-` the CLI's), and
 * unless `tmpsOnly`, every template that is not in `currentKeys` and was not used for `TEMPLATE_UNUSED_MAX_AGE_MS`. A template is as old as its `.last-used`
 * (touched at each copy), else its `template.json`; a directory without `template.json` is a build in progress or a crashed one, judged only by its tmp name.
 * Answers the names removed.
 */
export function pruneTemplates(cacheDir: string, currentKeys: ReadonlySet<string>, options: { readonly tmpsOnly?: boolean }, ports?: Pick<ModulesPorts, "pidAlive" | "now">): string[] {
  return pruneStore(cacheDir, currentKeys, TEMPLATE_UNUSED_MAX_AGE_MS, { fallbackFile: "template.json", tmpsOnly: options.tmpsOnly }, ports);
}
