import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { appEntry, appRoot, DATA_ROOT_ENV, DATA_ROOT_FILE, dataRoot, readDataRootFile } from "./paths.ts";

const DATA_ROOTS: readonly [string, NodeJS.ProcessEnv, NodeJS.Platform, string, string][] = [
  ["win32 is %LOCALAPPDATA%\\MineAI", { LOCALAPPDATA: "C:\\x" }, "win32", "C:\\Users\\p", "C:\\x\\MineAI"],
  ["win32 without LOCALAPPDATA falls back to the profile's AppData\\Local", {}, "win32", "C:\\Users\\p", "C:\\Users\\p\\AppData\\Local\\MineAI"],
  ["linux follows XDG_DATA_HOME", { XDG_DATA_HOME: "/d" }, "linux", "/home/p", "/d/mine-ai"],
  ["linux without XDG_DATA_HOME is ~/.local/share/mine-ai", {}, "linux", "/home/p", "/home/p/.local/share/mine-ai"],
  ["linux with an empty XDG_DATA_HOME is ~/.local/share/mine-ai", { XDG_DATA_HOME: "" }, "linux", "/home/p", "/home/p/.local/share/mine-ai"],
  ["darwin uses the XDG rule until a macOS ticket says otherwise", {}, "darwin", "/Users/p", "/Users/p/.local/share/mine-ai"],
];

for (const [title, env, platform, home, expected] of DATA_ROOTS) {
  test(`dataRoot on ${title}`, () => {
    assert.equal(dataRoot(env, platform, home, null), expected);
  });
}

const CHOSEN = "D:\\Jeux é\\Mine AI data";

test("the folder in MINE_AI_DATA_ROOT wins over the setup's file and over the default", () => {
  assert.equal(dataRoot({ [DATA_ROOT_ENV]: "E:\\Other", LOCALAPPDATA: "C:\\x" }, "win32", "C:\\Users\\p", CHOSEN), "E:\\Other");
});

test("an empty MINE_AI_DATA_ROOT is ignored", () => {
  assert.equal(dataRoot({ [DATA_ROOT_ENV]: "", LOCALAPPDATA: "C:\\x" }, "win32", "C:\\Users\\p", CHOSEN), CHOSEN);
});

test("the setup's file wins over the default folder", () => {
  assert.equal(dataRoot({ LOCALAPPDATA: "C:\\x" }, "win32", "C:\\Users\\p", CHOSEN), CHOSEN);
  assert.equal(dataRoot({}, "linux", "/home/p", "/srv/mine-ai"), "/srv/mine-ai");
});

/** A file system holding `text` for `data-root.txt` of the app folder, or throwing `code` like `readFileSync` does. */
const fileHolding = (text: string) => (path: string) => {
  assert.equal(path, join("C:\\App", DATA_ROOT_FILE));
  return Buffer.from(text, "utf8");
};
const fileFailing = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};

test("readDataRootFile reads the folder back exact: BOM, CRLF, spaces and é", () => {
  for (const text of [`${CHOSEN}`, `${CHOSEN}\r\n`, `\uFEFF${CHOSEN}\r\n`, `  ${CHOSEN} \n`]) {
    assert.equal(readDataRootFile("C:\\App", fileHolding(text), "win32"), CHOSEN, JSON.stringify(text));
  }
});

test("readDataRootFile gives null when the file is missing (a checkout, or a pre-W7 install)", () => {
  assert.equal(readDataRootFile("C:\\App", fileFailing("ENOENT"), "win32"), null);
});

test("readDataRootFile does not hide a file it cannot read: the default folder would show an empty install", () => {
  assert.throws(() => readDataRootFile("C:\\App", fileFailing("EACCES"), "win32"), /EACCES/u);
});

for (const [title, text, platform] of [
  ["empty", "\uFEFF\r\n", "win32"],
  ["relative", "Mine AI data", "win32"],
  ["drive-relative", "D:data", "win32"],
  ["a Windows folder read on Linux", "D:\\Mine AI", "linux"],
] as const) {
  test(`readDataRootFile refuses a file that is ${title}, naming the file and the value`, () => {
    assert.throws(
      () => readDataRootFile("C:\\App", fileHolding(text), platform),
      (error: Error) => error.message.includes(DATA_ROOT_FILE) && error.message.includes("reinstall Mine AI") && error.message.includes("full path") && error.message.includes(`("${text.replace(/^\uFEFF/u, "").trim()}")`),
    );
  });
}

test("appRoot is the folder holding launcher/", () => {
  assert.equal(appRoot(), join(import.meta.dir, "..", ".."));
});

test("MINE_AI_DATA_ROOT wins without the setup's file being read, so a broken file cannot stop a run that names its folder (review W7a 6)", () => {
  const broken = (): string | null => assert.fail("the file must not be read when the environment names the folder");
  assert.equal(dataRoot({ [DATA_ROOT_ENV]: "E:\\Other" }, "win32", "C:\\Users\\p", broken), "E:\\Other");
});

test("appEntry names the .ts source when the launcher runs from source, the .js bundle when it runs bundled", () => {
  assert.equal(appEntry("/app", "src/server/host.ts", false), join("/app", "src", "server", "host.ts"));
  assert.equal(appEntry("/app", "src/server/host.ts", true), join("/app", "src", "server", "host.js"));
  assert.equal(appEntry("/app", "launcher/src/listener/main.ts", true), join("/app", "launcher", "src", "listener", "main.js"));
});

test("this test file runs from source, so appEntry defaults to the .ts source", () => {
  assert.equal(appEntry("/app", "brain/src/main.ts"), join("/app", "brain", "src", "main.ts"));
});
