/** The region provider of a runtime: its own regions plus the other bots', refreshed on a timer (ADR-012). */
import type { ProtectedRegion } from "../world/protected-regions.js";
import type { BotDataScope } from "./bot-data-identity.js";
import { PEER_REGION_REFRESH_MS, PeerRegionReader } from "./peer-regions.js";
import type { ProtectedRegionStore } from "./protected-regions.js";
import type { SqlBotData } from "./sql-bot-data.js";

const NO_REGIONS: readonly ProtectedRegion[] = Object.freeze([]);

const logToStderr = (line: string) => void process.stderr.write(`${line}\n`);

/**
 * The provider the runtime hands to the guards (ADR-012). Temporary storage has no other bot to share with, so it is
 * the store's own list with no timer. A persistent file is refreshed every `PEER_REGION_REFRESH_MS` (other hosts of a
 * shared file write into it); with the per-bot scope the sibling bot files of its world are read too. Disposed with
 * `resources`.
 */
export function regionProviderFor(
  store: ProtectedRegionStore,
  botData: SqlBotData,
  scope: BotDataScope,
  resources: AsyncDisposableStack,
): () => readonly ProtectedRegion[] {
  if (botData.location.kind !== "persistent") return () => store.list();
  const peers = scope.kind === "bot" ? new PeerRegionReader(botData.location.file, logToStderr) : null;
  return resources.use(shareRegions(store, peers, logToStderr)).provider;
}

export interface SharedRegions extends Disposable {
  /** The regions the guards read, per priced break: this bot's own, then the other bots'. */
  readonly provider: () => readonly ProtectedRegion[];
}

/**
 * The region provider of a bot whose regions other bots can share: its own store plus the other bots' regions
 * (`peers`, the sibling files of its world; null when there are none to read), refreshed on a real-time interval.
 * The provider returns one frozen array, rebuilt only when the own list or the peers' changed, so a caller may keep it
 * and compare by identity. The interval is `unref`'d and cleared on dispose; a failed refresh is logged, never thrown
 * (it runs outside any action).
 */
export function shareRegions(
  store: ProtectedRegionStore,
  peers: PeerRegionReader | null,
  log: (line: string) => void,
  intervalMs: number = PEER_REGION_REFRESH_MS,
): SharedRegions {
  let peerRegions = peers?.read() ?? NO_REGIONS;
  let ownSeen: readonly ProtectedRegion[] | null = null;
  let peersSeen: readonly ProtectedRegion[] | null = null;
  let merged: readonly ProtectedRegion[] = NO_REGIONS;

  const provider = () => {
    const own = store.list();
    if (own !== ownSeen || peerRegions !== peersSeen) {
      ownSeen = own;
      peersSeen = peerRegions;
      merged = peerRegions.length === 0 ? own : Object.freeze([...own, ...peerRegions]);
    }
    return merged;
  };

  // Each part alone: one failing must not stop the other (a busy own file must not freeze the peers' regions).
  const refreshing: readonly (readonly [string, () => void])[] = [
    ["its own file", () => void store.refresh()],
    ["the other bots' files", () => void (peerRegions = peers?.read() ?? NO_REGIONS)],
  ];
  const timer = setInterval(() => {
    for (const [what, refresh] of refreshing) {
      try {
        refresh();
      } catch (error) {
        log(`[minecraft-peer-regions] refreshing ${what} failed, its regions stay as they were: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, intervalMs);
  timer.unref();

  return { provider, [Symbol.dispose]: () => clearInterval(timer) };
}
