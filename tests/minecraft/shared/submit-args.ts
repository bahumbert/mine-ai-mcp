// `submit`'s command line and how the daemon's messages print (the PASS/FAIL lines Mine Labs prints, which the scripts grep).
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SCENARIO_SERVER_ENV_NAMES } from "./config.ts";
import type { DaemonMessage } from "./protocol.ts";
import { ninePMountOf } from "./source-root.ts";

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
  /** `--hold`: a load batch, which waits for the queue ahead of it to empty and then runs alone (the master's `--load` only). */
  readonly hold: boolean;
}

const USAGE = "usage: submit.ts <scenario.yaml|dir>... [--repeat N] [--lanes N] [--lock] [--hold] [--isolated] [--out DIR] [--socket PATH] [--port BASE] | --stop";

function wholeNumber(option: string, value: string | undefined, minimum: number): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < minimum) throw new Error(`${option} needs a whole number of at least ${minimum}, got ${value ?? "nothing"}`);
  return parsed;
}

export function parseSubmitArgs(argv: readonly string[], cwd: string): SubmitArgs {
  const paths: string[] = [];
  const flags = { repeat: 1, lanes: null as number | null, out: resolve(cwd, ".mine-labs"), lock: false, isolated: false, stop: false, hold: false };
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
    else if (word === "--port") port = wholeNumber(word, argv[++at], 1);
    else if (word === "--out" || word === "--socket") {
      const value = argv[++at];
      if (value === undefined) throw new Error(`${word} needs a value`);
      if (word === "--out") flags.out = resolve(cwd, value);
      else socket = value;
    } else throw new Error(`unknown option ${word}. ${USAGE}`);
  }
  if (paths.length === 0 && !flags.stop) throw new Error(USAGE);
  return { paths, socket, port, ...flags };
}

/** Where `target` really is: the real path of its nearest existing ancestor (the output folder is made later) plus the rest. */
function realPathOfNearestAncestor(target: string): string {
  let ancestor = target;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return join(realpathSync(ancestor), relative(ancestor, target));
}

/**
 * A warning when the artifacts folder (`--out`) is on a 9P mount (`/mnt/d`), else null; `mounts` is `/proc/mounts` text.
 * 2026-11-06 (plan p4-01a T7): through the daemon, `fight-no-progress` failed 30 of 30 with "disk I/O error" from the
 * clients' bot-data SQLite store with artifacts on /mnt/d and passed with them on ext4; the failing SQLite step was not
 * kept and a fresh WSL did not reproduce it (7 of 7 runs, 36 of 36 parallel store opens under load), so the cause is unproven.
 */
export function outputOnNinePWarning(out: string, mounts: string, realPath: (path: string) => string = realPathOfNearestAncestor): string | null {
  const real = realPath(out);
  if (!ninePMountOf(real, mounts)) return null;
  return `warning: --out ${out} is on a 9P mount (${real}): the clients' bot-data SQLite store failed there with "disk I/O error" in a batch of runs on 2026-11-06 (cause unproven; other runs passed). If a run fails so, pass an --out on ext4 (under /tmp or ~/.cache), as .agent/scripts/scenario/scenario-repeat.sh does.`;
}

const OUTCOME_LABEL = { pass: "PASS", fail: "FAIL", timeout: "TIMEOUT", error: "ERROR", cancelled: "CANCELLED" } as const;

/** The lines to print for one daemon message. */
export function formatMessage(message: DaemonMessage): string[] {
  switch (message.type) {
    case "result":
      return ["", `${OUTCOME_LABEL[message.outcome]}  ${message.name}  ${(message.elapsedMs / 1000).toFixed(1)}s`,
        ...(message.error ? [message.error] : []), `  goal: ${message.detail}`];
    case "done":
      return [`session: ${message.passed}/${message.runs} passed, ${message.failed} failed, ${message.cancelled} cancelled`];
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
