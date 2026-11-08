/**
 * `THIRD-PARTY-NOTICES.txt` of the app folder: BSD and Apache-2.0 require their notice in a binary distribution, so the setup
 * ships one section per bundled package (found from the `Bun.build` metafile), per package copied as files
 * (`minecraft-data`) and for Bun. Written by `packageApp` (`bundle.ts`) straight into the app folder.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NODE_MODULES_SEGMENT = "node_modules/";
/** A licence file at a package's root: `LICENSE`, `license.md`, `COPYING`, `NOTICE` (any case). */
const LICENCE_FILE_NAME = /^(licen[cs]e|copying|notice)/iu;
const THIRD_PARTY_NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";
const BUN_LICENCE_FILE = "packaging/licenses/bun-LICENSE.md";

/** One block of the notices file: the title is `name@version` (or `Bun x.y.z`), the body the licence field and the licence texts. */
interface NoticeSection {
  readonly title: string;
  readonly body: string;
}

interface PackageNotice {
  readonly name: string;
  readonly version: string;
  readonly body: string;
}

/**
 * The package folders (absolute, `/` separators, sorted) that the metafile's input keys lie in. A key is relative to the
 * build's working folder (measured 2026-11-07: from `/tmp` Bun gave `../mnt/d/...`), so it is resolved from `cwd`; a package
 * is the folder after the last `node_modules/` (`<name>` or `@scope/<name>`), which makes a nested `a/node_modules/b` package
 * `b`. A key outside any `node_modules` is the app's own source. No package at all fails: a wrong key form must not ship an empty file.
 */
export function bundledPackageFolders(inputKeys: Iterable<string>, cwd: string): string[] {
  const folders = new Set<string>();
  for (const key of inputKeys) {
    const path = resolve(cwd, key.replaceAll("\\", "/")).replaceAll("\\", "/");
    const marker = path.lastIndexOf(`/${NODE_MODULES_SEGMENT}`);
    if (marker < 0) continue;
    const packageStart = marker + 1 + NODE_MODULES_SEGMENT.length;
    const parts = path.slice(packageStart).split("/");
    const nameParts = parts[0]!.startsWith("@") ? 2 : 1;
    if (parts.length > nameParts) folders.add(path.slice(0, packageStart) + parts.slice(0, nameParts).join("/"));
  }
  if (folders.size === 0) throw new Error("[BUILD_LICENSE] no bundled package found in the metafile: its input keys were not read as paths under node_modules.");
  return [...folders].sort();
}

function licenceTypeOf(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  const type = (value as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" && type !== "" ? type : undefined;
}

/** The `license` field of a `package.json` (a string, or an object with `type`), else the types of its `licenses` array. */
function licenceFieldOf(manifest: { license?: unknown; licenses?: unknown }): string | undefined {
  const single = licenceTypeOf(manifest.license);
  if (single !== undefined) return single;
  const types = Array.isArray(manifest.licenses) ? manifest.licenses.map(licenceTypeOf).filter((type) => type !== undefined) : [];
  return types.length > 0 ? types.join(", ") : undefined;
}

function noticeOfPackage(folder: string): PackageNotice {
  const manifestFile = join(folder, "package.json");
  if (!existsSync(manifestFile)) throw new Error(`[BUILD_LICENSE] ${folder} has no package.json: a metafile key under node_modules is not inside a package.`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { name?: unknown; version?: unknown; license?: unknown; licenses?: unknown };
  const name = typeof manifest.name === "string" ? manifest.name : folder;
  if (typeof manifest.version !== "string") throw new Error(`[BUILD_LICENSE] ${name} has no version in ${manifestFile}`);
  const license = licenceFieldOf(manifest);
  if (license === undefined) throw new Error(`[BUILD_LICENSE] ${name} has no license field`);
  const licenceFiles = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENCE_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const texts = licenceFiles.map((file) => `--- ${file} ---\n${readFileSync(join(folder, file), "utf8").trimEnd()}`);
  return { name, version: manifest.version, body: [`License: ${license}`, ...(texts.length > 0 ? texts : ["no licence file in the package"])].join("\n") };
}

function order(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One section per `name@version` of the folders (two folders of one `name@version`: the first folder in sorted order gives it), sorted by name then version. */
export function packageNoticeSections(folders: readonly string[]): NoticeSection[] {
  const notices = new Map<string, PackageNotice>();
  for (const folder of [...folders].sort()) {
    const notice = noticeOfPackage(folder);
    const key = `${notice.name}@${notice.version}`;
    if (!notices.has(key)) notices.set(key, notice);
  }
  return [...notices.values()]
    .sort((left, right) => order(left.name, right.name) || order(left.version, right.version))
    .map((notice) => ({ title: `${notice.name}@${notice.version}`, body: notice.body }));
}

/** Bun's own section: the zip holds only `bun.exe`, so its licence is the committed file; the version is the one the manifest pins. */
function bunNoticeSection(stageDir: string): NoticeSection {
  const manifest = JSON.parse(readFileSync(join(stageDir, "packaging", "manifest.json"), "utf8")) as { bun: { url: string } };
  const version = /bun-v(\d+\.\d+\.\d+)\//u.exec(manifest.bun.url)?.[1];
  if (version === undefined) throw new Error(`[BUILD_LICENSE] packaging/manifest.json bun.url names no bun-v<x.y.z>: ${manifest.bun.url}`);
  const licenceFile = join(stageDir, BUN_LICENCE_FILE);
  if (!existsSync(licenceFile)) throw new Error(`[BUILD_MISSING] ${BUN_LICENCE_FILE} is not in ${stageDir}.`);
  return { title: `Bun ${version}`, body: readFileSync(licenceFile, "utf8").trimEnd() };
}

/** The notices file text: a line saying what it is, then each section under a `===== title =====` line. */
function renderThirdPartyNotices(sections: readonly NoticeSection[]): string {
  const blocks = sections.map((section) => `===== ${section.title} =====\n${section.body}\n`);
  return `Mine AI includes the third-party software below. Each part keeps its own licence; the texts are reproduced as the packages ship them.\n\n${blocks.join("\n")}`;
}

/**
 * `THIRD-PARTY-NOTICES.txt` in `appDir`: one section per bundled package (from the metafile's input keys, read from `cwd`),
 * per folder of `copiedPackageFolders` (packages copied as files, not bundled) and for Bun (its licence from the stage).
 */
export function writeThirdPartyNotices(stageDir: string, appDir: string, inputKeys: Iterable<string>, copiedPackageFolders: readonly string[], cwd: string = process.cwd()): void {
  const folders = [...bundledPackageFolders(inputKeys, cwd), ...copiedPackageFolders];
  const sections = [...packageNoticeSections(folders), bunNoticeSection(stageDir)];
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, THIRD_PARTY_NOTICES_FILE), renderThirdPartyNotices(sections));
}
