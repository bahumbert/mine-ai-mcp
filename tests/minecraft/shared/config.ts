// Every constant of the shared scenario server, each overridable by an env variable MINE_AI_SCENARIO_<NAME>.
import { homedir } from "node:os";
import { join } from "node:path";

export interface ScenarioServerConfig {
  /** How often the daemon reads the machine and every server. */
  readonly sampleEveryMs: number;
  /** A server whose tick time P95 is under this admits new trials (half the 50 ms budget). */
  readonly msptAdmitMs: number;
  /**
   * Lanes a shared server takes before its first tick sample; more only once a sample shows its P95 under `msptAdmitMs` (T10, plan 2026-10-30-contract-batch-timing).
   * `msptAdmitMs` cannot hold back a server that has not been read: T9's warm-up (daemon.log, 2026-11-01) put all 28 lanes of the key on the fresh s2 in the first pass,
   * its P95 reading `-`, `-`, then 14.4, 27.9, 34.4, 37.8 ms (about 1.3 ms a lane at 28), and `columns-hold-cells` was red in 1 of 16 such warm-ups
   * (81 of 329 chunks, P95 92.8 ms); P4's template server held 24.9-27.5 ms under the whole first pass. 10 lanes is about 13 ms by that slope, half of `msptAdmitMs`.
   * T10's 6 warm-ups: the first reading comes 1.5-4 s after "ready", before the held clients load chunks (6.1-17.4 ms), so it lifts the bound for the rest; the next reading was 24-52 ms.
   */
  readonly freshServerLanes: number;
  /** A server over this twice in a row takes no new trial until it recovers. */
  readonly msptStopMs: number;
  /** Fraction of the machine's threads busy over the last sample window above which nothing new starts. */
  readonly cpuAdmit: number;
  /** Fraction busy under which a timing trial (a locked batch, a scenario tagged exclusive) starts and, while one runs, any trial starts. */
  readonly cpuCalm: number;
  /** Resident memory of one scenario client at full size: 210-221 MB peak measured by T1 (client-footprint.sh), 250 MB covers every run seen. */
  readonly clientMemMb: number;
  /**
   * Resident memory of a scenario client booted and waiting for `init`, before it logs in: 111-122 MB in 10 boots measured 2026-10-25 on WSL
   * (`.agent/scripts/scenario/client-boot-measure.ts`, the contract driver without and `single-action.ts` with the runtime; 125 covers them all). A client
   * spawned ahead reserves this from its spawn; its trial reserves only `clientMemMb - clientBootedMemMb` (what logging in adds). The logged-in
   * size is still T1's peak (`clientMemMb`): its size right after the login, and so the true difference, is to measure on a running trial (`ps`).
   */
  readonly clientBootedMemMb: number;
  /** Cpu seconds of one client boot (1.07-1.17 s in 10 boots, 2026-10-25, `client-boot-measure.ts`; 1.2 covers them): the scheduler adds it, over a sample window, to the busy cpu for each client it boots in one pass, so a pass cannot boot a whole cap of them into a machine at the bound. */
  readonly clientBootCpuSeconds: number;
  /**
   * Clients a submission may have booted or booting and not yet handed to a trial: one wave of the starting target, so the trials of the first
   * pass boot while they wait for the arrangement mutex. The memory ledger and the cpu bound decide whether one starts; this only bounds the
   * waste a submission that never reaches them can leave (to measure: T7g's `join` median).
   */
  readonly clientsAhead: number;
  /** Clients booted ahead in all submissions: two waves, so a second submission still boots its first wave beside a running one. */
  readonly clientsAheadMax: number;
  /** A client spawned ahead that has not said it booted after this long counts as a failed boot and is killed (Mine Labs waits 60 s for `ready` after a handover). */
  readonly clientBootBoundMs: number;
  /** Failed boots in a row (no boot succeeded between) after which a submission's trials of that client command fail with the boot's stderr and none is respawned. */
  readonly clientBootFailureLimit: number;
  /** A client counts as young (memory still growing) for this long after its admission. */
  readonly clientRampMs: number;
  /** What the memory ledger keeps free after every admission (a lane, an idle server's growth, a new server, a client booted ahead): the reserve that other daemons and a live run sharing the machine draw on. */
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
  /**
   * Servers a settings key may spread over at once. 1 (the default) keeps today's order: the key's second server starts only when
   * the first refuses a lane for its arrangement queue. Above 1, a key with at least `serversPerKey x lanesPerServer / 2` trials
   * queued starts its servers together and each trial takes the server with the shortest arrangement queue. 1 stays the default
   * (and with the default MAX_PLAYERS 100 the threshold is 98 trials for 2 servers: lower MAX_PLAYERS with it) until the T7c3 measure (`live-testing.md`, shared daemon) shows a faster contract batch with more.
   */
  readonly serversPerKey: number;
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
  /** 1 starts each submission's clients from a snapshot of the submitter's worktree on ext4 (spec 2026-10-30-scenario-clients-ext4); 0 starts them from `/mnt/d` as before. */
  readonly mirror: number;
  /**
   * A snapshot sync that has not ended after this long is killed and the submission starts its clients from `/mnt/d`. 3 x 7 912 ms, the largest of spike X3
   * (2026-10-31): the cold parallel sync beside today's batch; the warm one took 0.9 s idle, 1.2-1.8 s beside a batch whose clients read ext4, 4.2-5.9 s beside today's.
   */
  readonly mirrorSyncBoundMs: number;
  /** A `bun install` of a lockfile's `node_modules` on ext4 that has not ended after this long is killed. 3 x 1 288 ms, spike X2 (2026-10-30): the empty-cache install (warm cache 0.25-0.82 s). */
  readonly modulesInstallBoundMs: number;
  /** Where the snapshots and the `node_modules` trees live: on ext4, so the clients read no 9P. */
  readonly mirrorDir: string;
  /** 1 copies the template world into each lane (shared) server before it starts (spec 2026-10-30-scenario-clients-ext4 D10); 0 starts them empty, as before. */
  readonly worldTemplate: number;
  /** Lanes 1..N the template holds chunks for: spec Q4, the peak of lanes on one fresh shared server in the T7 measures. Another count is another key. */
  readonly templateLanes: number;
  /**
   * A template build that has not ended after this long fails with `bound: true` (and may be tried again). 3 x 59.9 s, spike P0 (2026-10-31): 43.8 s to
   * generate 35 604 chunks, 10.8 s for `save-all flush`, 5.3 s to stop the build server (`sync-chunk-writes=false`). The `world-template.ts build` command reads it too.
   */
  readonly templateBuildBoundMs: number;
  /**
   * A copy of the template into one server's world that has not ended after this long is killed and the server starts empty. 3 x 17 377 ms, the largest copy
   * measured on `/mnt/d` (spike P0b R1, 2026-10-31, 28-lane batch running; P0c R4 with the 22 620-block clones: 2 993-7 444 ms, quiet P0: 3.0-4.2 s).
   */
  readonly templateCopyBoundMs: number;
  /** Where the finished templates live (`<key>/`): on ext4, shared by every daemon and worktree. */
  readonly templateDir: string;
  readonly socketPath: string;
}

type NumberKey = { [K in keyof ScenarioServerConfig]: ScenarioServerConfig[K] extends number ? K : never }[keyof ScenarioServerConfig];

/** name of the env suffix, default, the largest value accepted (a share is at most 1), and whether 0 is accepted (a switch) */
const NUMBER_CONSTANTS: { readonly [K in NumberKey]: readonly [suffix: string, fallback: number, max?: number, zeroAllowed?: true] } = {
  sampleEveryMs: ["SAMPLE_EVERY_MS", 5_000],
  msptAdmitMs: ["MSPT_ADMIT_MS", 25],
  freshServerLanes: ["FRESH_SERVER_LANES", 10],
  msptStopMs: ["MSPT_STOP_MS", 35],
  cpuAdmit: ["CPU_ADMIT", 0.85, 1],
  cpuCalm: ["CPU_CALM", 0.6, 1],
  clientMemMb: ["CLIENT_MEM_MB", 250],
  clientBootedMemMb: ["CLIENT_BOOTED_MEM_MB", 125],
  clientBootCpuSeconds: ["CLIENT_BOOT_CPU_SECONDS", 1.2],
  clientsAhead: ["CLIENTS_AHEAD", 28],
  clientsAheadMax: ["CLIENTS_AHEAD_MAX", 56],
  clientBootBoundMs: ["CLIENT_BOOT_BOUND_MS", 60_000],
  clientBootFailureLimit: ["CLIENT_BOOT_FAILURE_LIMIT", 2],
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
  serversPerKey: ["SERVERS_PER_KEY", 1],
  waitReportMs: ["WAIT_REPORT_MS", 30_000],
  serverIdleMs: ["SERVER_IDLE_MS", 120_000],
  daemonIdleMs: ["DAEMON_IDLE_MS", 600_000],
  trialSlackMs: ["TRIAL_SLACK_MS", 120_000],
  restoreBoundMs: ["RESTORE_BOUND_MS", 60_000],
  stallStopMs: ["STALL_STOP_MS", 30_000],
  recoverySamples: ["RECOVERY_SAMPLES", 3],
  starveSamples: ["STARVE_SAMPLES", 3],
  maxPlayers: ["MAX_PLAYERS", 100],
  mirror: ["MIRROR", 1, 1, true],
  mirrorSyncBoundMs: ["MIRROR_SYNC_BOUND_MS", 23_736],
  modulesInstallBoundMs: ["MODULES_INSTALL_BOUND_MS", 3_864],
  worldTemplate: ["WORLD_TEMPLATE", 1, 1, true],
  templateLanes: ["TEMPLATE_LANES", 28],
  templateBuildBoundMs: ["TEMPLATE_BUILD_BOUND_MS", 180_000],
  templateCopyBoundMs: ["TEMPLATE_COPY_BOUND_MS", 52_131],
};

const ENV_PREFIX = "MINE_AI_SCENARIO_";
const DEFAULT_SOCKET = "/tmp/mine-ai-scenarios.sock";
const DEFAULT_MIRROR_DIR = join(homedir(), ".cache/mine-ai/scenario-mirror");
const DEFAULT_TEMPLATE_DIR = join(homedir(), ".cache/mine-ai/world-templates");

/** The env variables the daemon reads for itself (MINE_AI_SCENARIO_EVIDENCE and the like belong to the clients). */
export const SCENARIO_SERVER_ENV_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(NUMBER_CONSTANTS).map(([suffix]) => ENV_PREFIX + suffix),
  `${ENV_PREFIX}SOCKET_PATH`,
  `${ENV_PREFIX}MIRROR_DIR`,
  `${ENV_PREFIX}TEMPLATE_DIR`,
]);

function numberFromEnv(env: Record<string, string | undefined>, suffix: string, fallback: number, max: number | undefined, zeroAllowed: boolean): number {
  const name = ENV_PREFIX + suffix;
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (value === 0 && !zeroAllowed) || (max !== undefined && value > max)) {
    throw new Error(`${name}=${raw} is not a number ${zeroAllowed ? "from 0" : "above 0"}${max === undefined ? "" : ` and at most ${max}`}`);
  }
  return value;
}

/** The constants with the env overrides applied; a bad value throws naming its variable. */
export function loadScenarioServerConfig(env: Record<string, string | undefined> = process.env): ScenarioServerConfig {
  const numbers = Object.fromEntries(
    Object.entries(NUMBER_CONSTANTS).map(([name, [suffix, fallback, max, zeroAllowed]]) => [name, numberFromEnv(env, suffix, fallback, max, zeroAllowed === true)]),
  ) as Record<NumberKey, number>;
  if (!Number.isInteger(numbers.serversPerKey)) throw new Error(`${ENV_PREFIX}SERVERS_PER_KEY=${numbers.serversPerKey} is not a whole number from 1`);
  if (!Number.isInteger(numbers.clientBootFailureLimit)) throw new Error(`${ENV_PREFIX}CLIENT_BOOT_FAILURE_LIMIT=${numbers.clientBootFailureLimit} is not a whole number from 1`);
  if (!Number.isInteger(numbers.mirror)) throw new Error(`${ENV_PREFIX}MIRROR=${numbers.mirror} is not 0 or 1`);
  if (!Number.isInteger(numbers.worldTemplate)) throw new Error(`${ENV_PREFIX}WORLD_TEMPLATE=${numbers.worldTemplate} is not 0 or 1`);
  if (!Number.isInteger(numbers.templateLanes)) throw new Error(`${ENV_PREFIX}TEMPLATE_LANES=${numbers.templateLanes} is not a whole number from 1`);
  return {
    ...numbers, socketPath: env[`${ENV_PREFIX}SOCKET_PATH`] || DEFAULT_SOCKET, mirrorDir: env[`${ENV_PREFIX}MIRROR_DIR`] || DEFAULT_MIRROR_DIR,
    templateDir: env[`${ENV_PREFIX}TEMPLATE_DIR`] || DEFAULT_TEMPLATE_DIR,
  };
}

/** Lanes a shared server has: its player slots less a spectator and an operator. */
export function lanesPerServer(config: ScenarioServerConfig): number {
  return config.maxPlayers - 2;
}

/** Trials of one key queued at which its servers start together (`serversPerKey` above 1). */
export function spreadThreshold(config: ScenarioServerConfig): number {
  return config.serversPerKey * lanesPerServer(config) / 2;
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
