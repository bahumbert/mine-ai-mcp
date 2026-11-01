// The live list of the other agents' usernames, read from the file the launcher keeps (`--other-agents-file`).
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { otherAgentsFor } from "./brain-args.ts";

/** The launcher rewrites the file at each bot start or stop; a brain looks again at most this often. */
const OTHER_AGENTS_CHECK_MS = 1_000;

/** The file the launcher writes (`run/other-agents.json`): the usernames of the bots playing, and its listener. */
const otherAgentsFileSchema = z.object({ usernames: z.array(z.string()) });

export interface OtherAgentsDeps {
  stat(path: string): { mtimeMs: number; ino: number; size: number };
  read(path: string): string;
  now(): number;
  log(line: string): void;
}

const REAL_DEPS: OtherAgentsDeps = {
  stat: (path) => statSync(path),
  read: (path) => readFileSync(path, "utf8"),
  now: Date.now,
  log: (line) => console.log(`${new Date().toISOString()} [other-agents] ${line}`),
};

/**
 * The usernames one agent must not answer, live: the fixed ones (`--agent` / `--other-agent`) plus those in a file the
 * launcher keeps up to date, so a bot started from game chat is ignored by the running brains at once. `Agent` reads
 * `names()` on every chat line. A missing or invalid file keeps the last good names (one log line per bad state).
 */
export class OtherAgents {
  private current: readonly string[];
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  /** Time, inode and size of the file last read: the launcher's rename gives a new inode, for a coarse clock gives the same time twice. */
  private seenStamp: string | null = null;
  private loggedProblem: string | null = null;
  private readonly deps: OtherAgentsDeps;

  constructor(
    private readonly own: string,
    private readonly fixed: readonly string[],
    private readonly file: string | null,
    deps: Partial<OtherAgentsDeps> = {},
  ) {
    this.deps = { ...REAL_DEPS, ...deps };
    this.current = otherAgentsFor(own, fixed, []);
  }

  names(): readonly string[] {
    if (this.file !== null) this.refreshIfDue(this.file);
    return this.current;
  }

  private refreshIfDue(file: string): void {
    const now = this.deps.now();
    if (now - this.lastCheckAt < OTHER_AGENTS_CHECK_MS) return;
    this.lastCheckAt = now;
    let stamp: string;
    try {
      const { mtimeMs, ino, size } = this.deps.stat(file);
      stamp = `${mtimeMs}:${ino}:${size}`;
    } catch (error) {
      this.reportProblem(`file ${file} cannot be read (${String(error)})`);
      this.seenStamp = null;
      return;
    }
    if (stamp === this.seenStamp) return;
    this.seenStamp = stamp;
    this.readFile(file);
  }

  private readFile(file: string): void {
    let parsed: z.ZodSafeParseResult<z.infer<typeof otherAgentsFileSchema>>;
    try {
      parsed = otherAgentsFileSchema.safeParse(JSON.parse(this.deps.read(file)));
    } catch (error) {
      this.reportProblem(`file ${file} is not valid JSON (${String(error)})`);
      return;
    }
    if (!parsed.success) {
      this.reportProblem(`file ${file} does not hold { "usernames": string[] }`);
      return;
    }
    this.loggedProblem = null;
    this.current = otherAgentsFor(this.own, this.fixed, parsed.data.usernames);
  }

  /** One line per kind of problem until a good read: a launcher mid-write must not flood the brain's output. */
  private reportProblem(problem: string): void {
    if (problem === this.loggedProblem) return;
    this.loggedProblem = problem;
    this.deps.log(`${problem}; keeping the last names (${this.current.join(", ") || "none"})`);
  }
}
