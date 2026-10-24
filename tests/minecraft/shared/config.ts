// Every constant of the shared scenario server, each overridable by an env variable MINE_AI_SCENARIO_<NAME>.

export interface ScenarioServerConfig {
  /** How often the daemon reads the machine and every server. */
  readonly sampleEveryMs: number;
  /** A server whose tick time P95 is under this admits new trials (half the 50 ms budget). */
  readonly msptAdmitMs: number;
  /** A server over this twice in a row takes no new trial until it recovers. */
  readonly msptStopMs: number;
  /** Fraction of the machine's threads busy over the last sample window above which nothing new starts. */
  readonly cpuAdmit: number;
  /** Fraction busy under which a timing trial (a locked batch, a scenario tagged exclusive) starts and, while one runs, any trial starts. */
  readonly cpuCalm: number;
  /** Resident memory of one scenario client at full size: 210-221 MB peak measured by T1 (client-footprint.sh), 250 MB covers every run seen. */
  readonly clientMemMb: number;
  /** A client counts as young (memory still growing) for this long after its admission. */
  readonly clientRampMs: number;
  readonly serverMemMarginMb: number;
  /** What a java server needs above its heap (metaspace, threads, buffers). */
  readonly serverOverheadMb: number;
  readonly sharedHeapMb: number;
  readonly singleHeapMb: number;
  /** A shared server takes no more lanes once its resident size passes this share of heap + overhead. */
  readonly rssFull: number;
  /** Trials at once a batch may start with: 28 covers the contract batch (52 checks, about 780 s of lane time) in 30 s with a tail (plan T7c item 10, an estimate). */
  readonly targetStart: number;
  /** The target grows only after this long without a breach of any bound. */
  readonly growAfterMs: number;
  /** ...and then by one per this long while a trial waits at the target. */
  readonly growEveryMs: number;
  /** A cpu breach halves the target only when our process tree used at least this share of the busy cpu; below it the load is foreign. */
  readonly ownShareHalve: number;
  /** Mutex time per trial (its arrangement plus its restore) assumed for a server until it has settled 3 trials (T7b: about 0.8 s). */
  readonly arrangeHoldMs: number;
  /** A shared server takes no lane that would wait longer than this for its arrangement turn: the next server of the key takes it. */
  readonly arrangeQueueMs: number;
  readonly waitReportMs: number;
  readonly serverIdleMs: number;
  readonly daemonIdleMs: number;
  readonly trialSlackMs: number;
  readonly restoreBoundMs: number;
  readonly stallStopMs: number;
  /** Samples under `msptAdmitMs` a backed-off server needs before it takes trials again. */
  readonly recoverySamples: number;
  /** Samples a trial may wait for room for a new server before it holds back the later trials that would take that room. */
  readonly starveSamples: number;
  /** `max-players` of a shared server; lanes use two fewer (a spectator and an operator). */
  readonly maxPlayers: number;
  readonly socketPath: string;
}

type NumberKey = { [K in keyof ScenarioServerConfig]: ScenarioServerConfig[K] extends number ? K : never }[keyof ScenarioServerConfig];

/** name of the env suffix, default, and the largest value accepted (a share is at most 1) */
const NUMBER_CONSTANTS: { readonly [K in NumberKey]: readonly [suffix: string, fallback: number, max?: number] } = {
  sampleEveryMs: ["SAMPLE_EVERY_MS", 5_000],
  msptAdmitMs: ["MSPT_ADMIT_MS", 25],
  msptStopMs: ["MSPT_STOP_MS", 35],
  cpuAdmit: ["CPU_ADMIT", 0.85, 1],
  cpuCalm: ["CPU_CALM", 0.6, 1],
  clientMemMb: ["CLIENT_MEM_MB", 250],
  clientRampMs: ["CLIENT_RAMP_MS", 30_000],
  serverMemMarginMb: ["SERVER_MEM_MARGIN_MB", 1_024],
  serverOverheadMb: ["SERVER_OVERHEAD_MB", 512],
  sharedHeapMb: ["SHARED_HEAP_MB", 3_072],
  singleHeapMb: ["SINGLE_HEAP_MB", 2_048],
  rssFull: ["RSS_FULL", 0.85, 1],
  targetStart: ["TARGET_START", 28],
  growAfterMs: ["GROW_AFTER_MS", 60_000],
  growEveryMs: ["GROW_EVERY_MS", 15_000],
  ownShareHalve: ["OWN_SHARE_HALVE", 0.5, 1],
  arrangeHoldMs: ["ARRANGE_HOLD_MS", 800],
  arrangeQueueMs: ["ARRANGE_QUEUE_MS", 5_000],
  waitReportMs: ["WAIT_REPORT_MS", 30_000],
  serverIdleMs: ["SERVER_IDLE_MS", 120_000],
  daemonIdleMs: ["DAEMON_IDLE_MS", 600_000],
  trialSlackMs: ["TRIAL_SLACK_MS", 120_000],
  restoreBoundMs: ["RESTORE_BOUND_MS", 60_000],
  stallStopMs: ["STALL_STOP_MS", 30_000],
  recoverySamples: ["RECOVERY_SAMPLES", 3],
  starveSamples: ["STARVE_SAMPLES", 3],
  maxPlayers: ["MAX_PLAYERS", 100],
};

const ENV_PREFIX = "MINE_AI_SCENARIO_";
const DEFAULT_SOCKET = "/tmp/mine-ai-scenarios.sock";

/** The env variables the daemon reads for itself (MINE_AI_SCENARIO_EVIDENCE and the like belong to the clients). */
export const SCENARIO_SERVER_ENV_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(NUMBER_CONSTANTS).map(([suffix]) => ENV_PREFIX + suffix),
  `${ENV_PREFIX}SOCKET_PATH`,
]);

function numberFromEnv(env: Record<string, string | undefined>, suffix: string, fallback: number, max: number | undefined): number {
  const name = ENV_PREFIX + suffix;
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (max !== undefined && value > max)) {
    throw new Error(`${name}=${raw} is not a number above 0${max === undefined ? "" : ` and at most ${max}`}`);
  }
  return value;
}

/** The constants with the env overrides applied; a bad value throws naming its variable. */
export function loadScenarioServerConfig(env: Record<string, string | undefined> = process.env): ScenarioServerConfig {
  const numbers = Object.fromEntries(
    Object.entries(NUMBER_CONSTANTS).map(([name, [suffix, fallback, max]]) => [name, numberFromEnv(env, suffix, fallback, max)]),
  ) as Record<NumberKey, number>;
  return { ...numbers, socketPath: env[`${ENV_PREFIX}SOCKET_PATH`] || DEFAULT_SOCKET };
}

export interface PortBlock { readonly first: number; readonly last: number }

const DEFAULT_BLOCK: PortBlock = { first: 25_400, last: 25_559 };
const ISOLATED_RUNS: PortBlock = { first: 25_566, last: 25_574 };
const LIVE_HOSTS_FIRST = 25_575;
const BLOCK_SIZE_WITH_PORT = 40;

/** Game ports a daemon may hand out: the default block, or 40 ports from `--port`; refused if it meets another owner's ports. */
export function portBlockOf(base: number | undefined): PortBlock {
  if (base === undefined) return DEFAULT_BLOCK;
  if (!Number.isInteger(base) || base < 1_024) throw new Error(`--port ${base} is not a usable base port`);
  const block = { first: base, last: base + BLOCK_SIZE_WITH_PORT - 1 };
  const meets = (other: PortBlock): boolean => block.first <= other.last && block.last >= other.first;
  if (meets(DEFAULT_BLOCK)) throw new Error(`--port ${base}: ${block.first}-${block.last} meets 25400-25559, the default daemon's block`);
  if (meets(ISOLATED_RUNS)) throw new Error(`--port ${base}: ${block.first}-${block.last} meets 25566-25574, the ports of isolated runs`);
  if (block.last >= LIVE_HOSTS_FIRST) throw new Error(`--port ${base}: ${block.first}-${block.last} reaches 25575 and up, the ports of live bot hosts`);
  return block;
}
