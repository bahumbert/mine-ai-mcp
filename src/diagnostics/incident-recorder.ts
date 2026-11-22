import type { IncidentCaptureResult, IncidentReference, IncidentTrigger } from "../bot-data/incident-log.js";

// Twenty seconds covers the 12.6-second fatal run-12 leg. The byte budget
// bounds serialized history during entity/block bursts, not JavaScript heap.
export const INCIDENT_HISTORY_MS = 20_000;
export const INCIDENT_HISTORY_BYTES = 8 * 1024 * 1024;

export type SourceIdentity =
  | { readonly kind: "git"; readonly revision: string; readonly dirtyFingerprint: string }
  | { readonly kind: "unavailable"; readonly reason: string };
export interface IncidentProvenance {
  readonly source: SourceIdentity;
  readonly instanceId: string;
  readonly minecraft: { readonly host: string; readonly port: number };
}

interface Entry {
  /** Record order. Coverage compares sequence numbers, never times: two rows can share one millisecond. */
  readonly seq: number;
  readonly atMs: number;
  readonly bytes: Buffer;
}
export interface IncidentCapture {
  readonly trigger: IncidentTrigger;
  readonly requestId: number | null;
  readonly precedingRequestId: number | null;
  readonly contents: readonly Uint8Array[];
}

interface PendingCapture {
  readonly atMs: number;
  /** The newest row sequence the snapshot holds. */
  readonly seq: number;
  /** The rows the snapshot holds, oldest first: a replacement carries forward the rows the ring has since dropped. */
  readonly rows: readonly Entry[];
  readonly capture: IncidentCapture;
  /** A checkpoint a trim queued for rows no artifact holds yet: it bypasses the damage cadence. */
  readonly forced: boolean;
  readonly settle: (result: IncidentCaptureResult) => void;
}

/** Bounded immutable history and one writer. It observes; it never controls the bot. */
export class IncidentRecorder {
  #entries: Entry[] = [];
  #bytes = 0;
  #seq = 0;
  #omitted = { records: 0, firstAtMs: null as number | null, lastAtMs: null as number | null };
  #plan: Buffer | null = null;
  #writing: Promise<void> | null = null;
  #saving: IncidentCapture | null = null;
  #pending: PendingCapture | null = null;
  #coalesced = 0;
  #lastSavedDamageCapturedAt: number | null = null;
  /** Sequence of the newest damage hit, saved or coalesced; -1 before any. */
  #damageSeq = -1;
  /** Sequence of the newest damage row a written checkpoint holds; -1 before any. */
  #lastSavedDamageSeq = -1;
  /** Rows up to this sequence are in a written artifact or in a queued snapshot. */
  #coveredSeq = -1;
  /** Rows up to this sequence are in a written artifact. */
  #durableSeq = -1;
  #recordingMs = 0;
  #samples = 0;
  #writeFailures = 0;
  #lastWriteError: string | null = null;
  #maxRecordingMs = 0;

  constructor(
    private readonly identity: object,
    private readonly save: (capture: IncidentCapture) => Promise<IncidentReference>,
    private readonly published: (reference: IncidentReference) => void,
    private readonly budget = { durationMs: INCIDENT_HISTORY_MS, bytes: INCIDENT_HISTORY_BYTES },
    private readonly context: () => object = () => ({}),
    /** Wall-clock reading in epoch ms that stamps and ages the rows; tests pass their manual clock's `now`. */
    private readonly wallClock: () => number = () => Date.now(),
  ) {}

  record(kind: string, facts: object, atMs = this.wallClock()): void {
    const started = performance.now();
    // Fine-grained events correlate with physics and decision snapshots by
    // timestamp. Repeating the full policy/ownership state on every route or
    // execution event consumed most of the byte window during combat.
    const context = ["execution", "navigation", "packet", "server_position_applied", "nearby_block_change", "survival_receipt", "combat_decision"].includes(kind)
      ? {}
      : this.context();
    const bytes = Buffer.from(`${JSON.stringify({ kind, atMs, ...facts, ...context })}\n`);
    this.#seq += 1;
    this.#entries.push({ seq: this.#seq, atMs, bytes });
    this.#bytes += bytes.length;
    this.#trim(atMs);
    const cost = performance.now() - started;
    this.#recordingMs += cost;
    this.#maxRecordingMs = Math.max(this.#maxRecordingMs, cost);
    this.#samples += 1;
  }

  retainPlan(plan: object): void {
    this.#plan = Buffer.from(`${JSON.stringify({ kind: "retained_plan", ...plan })}\n`);
  }

  #trim(now: number): void {
    const removed = this.#evictionCount(now);
    if (removed === 0) return;
    // Rows are in record order, so the newest row this trim drops is the one that decides.
    if (!this.#mayDrop(this.#entries[removed - 1]!, now)) return;
    const retiring = this.#entries.slice(0, removed);
    for (const entry of retiring) {
      this.#bytes -= entry.bytes.length;
      if (entry.atMs >= now - this.budget.durationMs) {
        this.#omitted.records += 1;
        this.#omitted.firstAtMs ??= entry.atMs;
        this.#omitted.lastAtMs = entry.atMs;
      }
    }
    this.#entries.splice(0, removed);
  }

  /** How many of the oldest rows a trim at `now` drops: expired first, then the oldest rows over the byte budget. */
  #evictionCount(now: number): number {
    let count = 0;
    let bytes = this.#bytes;
    for (const entry of this.#entries) {
      const expired = entry.atMs < now - this.budget.durationMs;
      if (!expired && bytes <= this.budget.bytes) break;
      bytes -= entry.bytes.length;
      count += 1;
    }
    return count;
  }

  capture(
    trigger: IncidentTrigger,
    requestId: number | null,
    precedingRequestId: number | null = null,
  ): Promise<IncidentCaptureResult> {
    const atMs = this.wallClock();
    this.#trim(atMs);
    if (trigger === "non_entity_damage") this.#damageSeq = this.#seq;
    if (this.#damageCheckpointRecent(trigger, atMs)) {
      this.#coalesced += 1;
      return Promise.resolve({ kind: "coalesced" });
    }
    return this.#queue(trigger, requestId, precedingRequestId, atMs, false);
  }

  #queue(
    trigger: IncidentTrigger,
    requestId: number | null,
    precedingRequestId: number | null,
    atMs: number,
    forced: boolean,
  ): Promise<IncidentCaptureResult> {
    // A replacement holds every row its predecessor held: a row a trim dropped since then is carried forward, so a
    // snapshot queued just before a capture (D13) cannot leave an unsaved row in no artifact.
    const firstRingSeq = this.#entries[0]?.seq ?? Number.POSITIVE_INFINITY;
    const carried = this.#pending ? this.#pending.rows.filter((row) => row.seq < firstRingSeq) : [];
    if (this.#pending) {
      this.#coalesced += 1;
      this.#pending.settle({ kind: "coalesced" });
    }
    const seq = this.#seq;
    const rows = [...carried, ...this.#entries];
    const header = Buffer.from(
      `${JSON.stringify({
        kind: "incident",
        version: 1,
        atMs,
        trigger,
        requestId,
        precedingRequestId,
        identity: this.identity,
        history: {
          ...this.budget,
          retainedBytes: this.#bytes,
          firstAtMs: this.#entries[0]?.atMs ?? null,
          byteBudgetOmissions: this.#omitted,
        },
        recorder: { samples: this.#samples, recordingMs: this.#recordingMs, coalescedCaptures: this.#coalesced },
      })}\n`,
    );
    const capture: IncidentCapture = {
      trigger,
      requestId,
      precedingRequestId,
      contents: [header, ...(this.#plan ? [this.#plan] : []), ...rows.map((row) => row.bytes)],
    };
    // A slow filesystem cannot queue an unbounded number of 8-MiB snapshots.
    // Keep the latest pending snapshot; every trigger remains in its history.
    // At most one writing and one pending capture retain older buffer entries.
    const completion = new Promise<IncidentCaptureResult>((settle) => {
      this.#pending = { atMs, seq, rows, capture, forced, settle };
    });
    this.#coveredSeq = Math.max(this.#coveredSeq, seq);
    if (!this.#writing) this.#writing = this.#drain();
    return completion;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending) {
        const { atMs, seq, rows, capture, forced, settle } = this.#pending;
        this.#pending = null;
        // The cadence may coalesce a snapshot only when discarding it loses no row: a snapshot that holds rows the ring
        // has since dropped is the only copy of them, so it is written (D13).
        if (!forced && this.#damageCheckpointRecent(capture.trigger, atMs) && !this.#holdsUnsavedDroppedRows(rows)) {
          this.#coalesced += 1;
          // The discarded snapshot covers nothing: its rows are unprotected again until a later snapshot.
          this.#coveredSeq = this.#durableSeq;
          settle({ kind: "coalesced" });
          continue;
        }
        this.#saving = capture;
        try {
          const reference = await this.save(capture);
          if (reference.artifact.kind === "failed") {
            this.#writeFailures++;
            this.#lastWriteError = reference.artifact.error;
            this.#coveredSeq = this.#durableSeq;
          } else {
            this.#markDurable(capture.trigger, atMs, seq);
          }
          this.published(reference);
          settle({ kind: "completed", reference });
        } catch (cause) {
          this.#writeFailures++;
          this.#lastWriteError = String(cause);
          this.#coveredSeq = this.#durableSeq;
          settle({ kind: "failed", error: String(cause) });
        }
      }
    } finally {
      this.#writing = null;
      this.#saving = null;
    }
  }

  #markDurable(trigger: IncidentTrigger, atMs: number, seq: number): void {
    this.#durableSeq = Math.max(this.#durableSeq, seq);
    if (trigger !== "non_entity_damage") return;
    this.#lastSavedDamageCapturedAt = atMs;
    this.#lastSavedDamageSeq = seq;
  }

  /**
   * D13. A trim may drop rows up to `newest` only when they are covered, or hold no unsaved damage. Otherwise a
   * checkpoint of the whole ring is queued now and bypasses the damage cadence: that snapshot holds the rows. A pending
   * snapshot is never replaced, because a replacement could not hold the rows the first one lost; the drop waits for it,
   * up to twice the byte budget (past that the oldest rows go, counted as omissions).
   */
  #mayDrop(newest: Entry, now: number): boolean {
    if (newest.seq <= this.#coveredSeq || !this.#hasUnsavedDamage()) return true;
    if (!this.#pending) {
      void this.#queue("non_entity_damage", null, null, now, true);
      return true;
    }
    return this.#bytes > this.budget.bytes * 2;
  }

  #hasUnsavedDamage(): boolean {
    return this.#damageSeq > this.#lastSavedDamageSeq;
  }

  /** Rows a snapshot holds that the ring has dropped and no written artifact holds yet. */
  #holdsUnsavedDroppedRows(rows: readonly Entry[]): boolean {
    const firstRingSeq = this.#entries[0]?.seq ?? Number.POSITIVE_INFINITY;
    return rows.some((row) => row.seq > this.#durableSeq && row.seq < firstRingSeq);
  }

  /**
   * Recurring damage checkpoints compare capture times across the existing
   * history window; slow persistence does not extend the interval. Every hit
   * stays in the ring, but does not get an independent artifact. Unsaved damage
   * rows are not dropped without a checkpoint first (D13). Terminal and operator
   * captures always bypass this cadence, as do failed writes and checkpoints a trim forces.
   */
  #damageCheckpointRecent(trigger: IncidentTrigger, atMs: number): boolean {
    return (
      trigger === "non_entity_damage" &&
      this.#lastSavedDamageCapturedAt !== null &&
      atMs - this.#lastSavedDamageCapturedAt < this.budget.durationMs
    );
  }

  async flush(): Promise<void> {
    await this.#writing;
  }
  status() {
    return {
      samples: this.#samples,
      recordingMs: this.#recordingMs,
      maxRecordingMs: this.#maxRecordingMs,
      retainedBytes: this.#bytes,
      pendingCaptures: Number(this.#saving !== null) + Number(this.#pending !== null),
      coalescedCaptures: this.#coalesced,
      writeFailures: this.#writeFailures,
      lastWriteError: this.#lastWriteError,
    };
  }
}
