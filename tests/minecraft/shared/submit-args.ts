// `submit`'s command line and how the daemon's messages print (the PASS/FAIL lines Mine Labs prints, which the scripts grep).
import { join, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { loadScenario } from "mine-labs";
import { SCENARIO_SERVER_ENV_NAMES } from "./config.ts";
import type { DaemonMessage } from "./protocol.ts";

export interface SubmitArgs {
  readonly paths: string[];
  readonly repeat: number;
  readonly lanes: number | null;
  readonly out: string;
  readonly lock: boolean;
  readonly isolated: boolean;
  readonly stop: boolean;
  readonly socket: string | undefined;
  readonly port: number | undefined;
  readonly tickRate: number | null;
  /** `--hold`: a load batch, which waits for the queue ahead of it to empty and then runs alone (the master's `--load` only). */
  readonly hold: boolean;
}

const USAGE = "usage: submit.ts <scenario.yaml|dir>... [--repeat N] [--lanes N] [--tick-rate N] [--lock] [--hold] [--isolated] [--out DIR] [--socket PATH] [--port BASE] | --stop";

function wholeNumber(option: string, value: string | undefined, minimum: number): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < minimum) throw new Error(`${option} needs a whole number of at least ${minimum}, got ${value ?? "nothing"}`);
  return parsed;
}

export function parseSubmitArgs(argv: readonly string[], cwd: string): SubmitArgs {
  const paths: string[] = [];
  const flags = { repeat: 1, lanes: null as number | null, tickRate: null as number | null, out: resolve(cwd, ".mine-labs"), lock: false, isolated: false, stop: false, hold: false };
  let socket: string | undefined;
  let port: number | undefined;
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    if (!word.startsWith("--")) { paths.push(resolve(cwd, word)); continue; }
    if (word === "--lock") flags.lock = true;
    else if (word === "--hold") flags.hold = true;
    else if (word === "--isolated") flags.isolated = true;
    else if (word === "--stop") flags.stop = true;
    else if (word === "--repeat") flags.repeat = wholeNumber(word, argv[++at], 1);
    else if (word === "--lanes") flags.lanes = wholeNumber(word, argv[++at], 1);
    else if (word === "--tick-rate") {
      const value = argv[++at];
      const rate = Number(value);
      if (value === undefined || !Number.isFinite(rate) || rate < 1 || rate > 20) throw new Error(`--tick-rate needs a number from 1 to 20, got ${value ?? "nothing"}`);
      flags.tickRate = rate;
    }
    else if (word === "--port") port = wholeNumber(word, argv[++at], 1);
    else if (word === "--out" || word === "--socket") {
      const value = argv[++at];
      if (value === undefined) throw new Error(`${word} needs a value`);
      if (word === "--out") flags.out = resolve(cwd, value);
      else socket = value;
    } else throw new Error(`unknown option ${word}. ${USAGE}`);
  }
  if (paths.length === 0 && !flags.stop) throw new Error(USAGE);
  if (flags.isolated && flags.tickRate !== null) throw new Error("--tick-rate needs the daemon");
  return { paths, socket, port, ...flags };
}

const OUTCOME_LABEL = { pass: "PASS", fail: "FAIL", timeout: "TIMEOUT", error: "ERROR", cancelled: "CANCELLED" } as const;
export const SUBMIT_FEATURES = "MINE_AI_SUBMIT_FEATURES";
export const SUBMIT_CANARY = "MINE_AI_SUBMIT_CANARY";

/** Read cheap tag lines first; load only candidates so discovery costs no full-tree scenario expansion. */
async function canariesIn(root: string): Promise<string[]> {
  const files = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(files.map(async file => {
    const path = join(root, file.name);
    if (file.isDirectory()) return canariesIn(path);
    if (!file.isFile() || !/\.ya?ml$/iu.test(file.name)) return [];
    try {
      const text = await readFile(path, "utf8");
      if (!/^tags:\s*\[[^\]\n]*\bcanary\b[^\]\n]*\]/mu.test(text)) return [];
      return (await loadScenario(path)).tags.includes("canary") ? [path] : [];
    }
    catch { return []; }
  }));
  return found.flat();
}

/** Choose the first valid tagged scenario by path; a missing or ambiguous canary is visible to the submitter. */
export async function findCanary(scenariosRoot: string): Promise<{ path: string | null; note: string | null }> {
  const paths = (await canariesIn(resolve(scenariosRoot))).sort();
  return { path: paths[0] ?? null, note: paths.length === 0 ? "no bench canary found; batch runs without a canary" : paths.length > 1 ? `multiple bench canaries found; using ${paths[0]}` : null };
}

/** Exit 3 means every failure was infrastructure and nothing was cancelled. */
export function exitCodeOf(done: Extract<DaemonMessage, { type: "done" }>): 0 | 1 | 3 {
  if (done.cancelled > 0) return 1;
  if (done.failed === 0) return 0;
  return done.infra === done.failed ? 3 : 1;
}

/** Forward client variables and announce the protocol features this submitter understands. */
export function submitEnv(env: Readonly<Record<string, string | undefined>>, cwd?: string, canary?: string | null): Record<string, string> {
  const forwarded = Object.fromEntries(Object.entries(forwardedEnv(env, cwd)).filter(([name]) => !name.startsWith("MINE_AI_SUBMIT_")));
  return { ...forwarded, [SUBMIT_FEATURES]: "classes,canary", ...(canary ? { [SUBMIT_CANARY]: canary } : {}) };
}

/** The lines to print for one daemon message. */
export function formatMessage(message: DaemonMessage): string[] {
  switch (message.type) {
    case "result":
      return ["", `${message.class === "infra" ? "INFRA" : OUTCOME_LABEL[message.outcome]}  ${message.name}  ${(message.elapsedMs / 1000).toFixed(1)}s${message.retried ? ` (after an infra retry: ${message.retried})` : ""}`,
        ...(message.cause ? [`  cause: ${message.cause}`] : []), ...(message.error ? [message.error] : []), `  goal: ${message.detail}`];
    case "done":
      return [`session: ${message.passed}/${message.runs} passed, ${message.failed} failed, ${message.infra === undefined ? "" : `${message.infra} infra, `}${message.cancelled} cancelled`];
    case "wait": return [`waiting: ${message.text}`];
    case "error": return [`ERROR  ${message.text}`];
    case "info": return [message.text];
    case "status": return [message.text];
    case "stopping": return ["daemon stopping once its trials end"];
  }
}

/** The one forwarded variable that names a file the client writes: relative, it would mean a file in whatever directory the client starts in (a snapshot, since the mirror), not where the submitter typed it. */
const PATH_VARIABLES: ReadonlySet<string> = new Set(["MINE_AI_DIG_TRACE"]);

/**
 * The variables a submitter hands to the clients: its MINE_AI_* ones, not the daemon's own settings or a lane's offset.
 * With `cwd` (the directory `submit` ran in), a relative path variable is made absolute against it.
 */
export function forwardedEnv(env: Readonly<Record<string, string | undefined>>, cwd?: string): Record<string, string> {
  const forwarded = Object.entries(env).filter((entry): entry is [string, string] =>
    entry[0].startsWith("MINE_AI_") && !SCENARIO_SERVER_ENV_NAMES.has(entry[0]) && entry[0] !== "MINE_AI_ARENA" && entry[1] !== undefined);
  return Object.fromEntries(forwarded.map(([name, value]) => [name, cwd !== undefined && PATH_VARIABLES.has(name) ? resolve(cwd, value) : value]));
}
