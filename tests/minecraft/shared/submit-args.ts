// `submit`'s command line and how the daemon's messages print (the PASS/FAIL lines Mine Labs prints, which the scripts grep).
import { resolve } from "node:path";
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
  /** Set on the inner run of `--lock`, which already holds /tmp/mine-labs.lock. */
  readonly holdsLock: boolean;
}

const USAGE = "usage: submit.ts <scenario.yaml|dir>... [--repeat N] [--lanes N] [--lock] [--isolated] [--out DIR] [--socket PATH] [--port BASE] | --stop";

function wholeNumber(option: string, value: string | undefined, minimum: number): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < minimum) throw new Error(`${option} needs a whole number of at least ${minimum}, got ${value ?? "nothing"}`);
  return parsed;
}

export function parseSubmitArgs(argv: readonly string[], cwd: string): SubmitArgs {
  const paths: string[] = [];
  const flags = { repeat: 1, lanes: null as number | null, out: resolve(cwd, ".mine-labs"), lock: false, isolated: false, stop: false, holdsLock: false };
  let socket: string | undefined;
  let port: number | undefined;
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    if (!word.startsWith("--")) { paths.push(resolve(cwd, word)); continue; }
    if (word === "--lock") flags.lock = true;
    else if (word === "--holds-lock") flags.holdsLock = true;
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

/** The variables a submitter hands to the clients: its MINE_AI_* ones, not the daemon's own settings or a lane's offset. */
export function forwardedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] =>
    entry[0].startsWith("MINE_AI_") && !SCENARIO_SERVER_ENV_NAMES.has(entry[0]) && entry[0] !== "MINE_AI_ARENA" && entry[1] !== undefined));
}
