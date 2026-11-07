// What the agent knows and keeps across restarts: known places, farms, protected areas, its own outcomes, activity time, the unfinished house.
import type { AgentOptions } from "../agent.ts";
import type { Body } from "../body.ts";
import { describeStage } from "../farming/growth.ts";
import type { KnownPlace } from "../mind.ts";
import { activityNotesQuery, memoryNote, recall, recallQuery, shelterNotesQuery, staleActivityNotes, staleShelterNotes, type KnownFarm, type Memory, type ShelterHole } from "../memory.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { ProtectedArea } from "../runtime-client.ts";
import type { UnfinishedHouse } from "../skills.ts";
import { RESUME_RANGE } from "../skills/build-house.ts";
import { lastOfPlay, RECENT_MINUTES, type ActivityTime } from "../time-spent.ts";

/** Known places shown to the models; the oldest is forgotten first. */
const KNOWN_PLACES = 8;
/** Outcomes of its own objectives remembered for the goal tier. */
const OWN_MEMORY = 5;
/** Farms it remembers and every tier sees. */
const KNOWN_FARMS = 4;
/** Activity records read back at start: more than an hour of steps. */
const ACTIVITY_MEMORY = 200;
/** How often activity-time notes older than the last hour of play are deleted (the hour rotates). */
const ROTATE_EVERY_MS = 10 * 60_000;
/** At most this many notes deleted in one `note_delete`. */
const DELETE_BATCH = 500;

export class AgentMemory {
  readonly places: KnownPlace[] = [];
  /** Its farms, oldest first, each as it was at its last tend. */
  readonly farms: KnownFarm[] = [];
  /** The hole it last dug in this run (see {@link rememberShelter}); none before the first dig-in. */
  shelter: ShelterHole | null = null;
  readonly lately: string[] = [];
  /** Each finished step's activity and time over the last hour of play, oldest first. */
  readonly times: ActivityTime[] = [];
  /** The areas it never digs or places blocks in (ADR-012), kept in step with the skills that change them. */
  readonly areas: ProtectedArea[] = [];
  readonly building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  /** The unfinished house as last saved to memory, to save it again only when it changed. */
  private savedUnfinished = "null";
  /** When old activity notes were last deleted. */
  private rotatedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: Pick<AgentOptions, "runtime" | "log" | "persona">, private readonly body: Body) {}

  /**
   * The places shown to the models: the known ones, and the unfinished house with where to stand to resume it (live
   * 2026-10-02: asked to "go back and finish the house you started", she began a new one where she stood).
   */
  knownPlaces(): KnownPlace[] {
    // Her farms, as they were at their last tend: the models only know what the situation says (when to come back is
    // their choice).
    const farms = this.farms.map((farm): KnownPlace => {
      const growth = describeStage(farm.state);
      return {
        name: `your ${farm.crop} farm`,
        detail: `${farm.size}x${farm.size} around ${farm.centre.x} ${farm.centre.y} ${farm.centre.z}; ${farm.state.planted} planted, ${farm.state.ripe} ripe, ${farm.state.empty} empty${growth === "" ? "" : `, ${growth}`} when you last tended it, ${minutesAgo(farm.tendedAt)}; farming it again harvests what is ripe and replants it`,
      };
    });
    const house = this.building.unfinished;
    if (house === null) return [...this.places, ...farms];
    const { x, y, z } = house.site.door;
    return [...this.places, ...farms, { name: `your unfinished ${house.kind}`, detail: `door ${x} ${y} ${z}; go within ${RESUME_RANGE} blocks of the door, then build it again to finish it` }];
  }

  /** Its latest own house that still has temporary parts: the latest note of each place name counts, an improved one no longer. */
  temporaryHouse(): KnownPlace | null {
    const latest = new Map<string, KnownPlace>();
    for (const place of this.places) latest.set(place.name, place);
    return [...latest.values()].reverse().find((place) => place.own === true && Object.keys(place.house?.materials ?? {}).length > 0) ?? null;
  }

  learnPlace(place: KnownPlace): void {
    this.options.log(`known place: ${place.name} (${place.detail})`);
    this.places.push(place);
    if (this.places.length > KNOWN_PLACES) this.places.splice(0, this.places.length - KNOWN_PLACES);
    this.memorize({ kind: "place", place });
  }

  learnFarm(farm: KnownFarm): void {
    this.options.log(`farm: ${farm.crop} ${farm.size}x${farm.size} around ${farm.centre.x} ${farm.centre.y} ${farm.centre.z} (${farm.state.planted} planted)`);
    const index = this.farms.findIndex((known) => known.centre.x === farm.centre.x && known.centre.y === farm.centre.y && known.centre.z === farm.centre.z);
    if (index >= 0) this.farms.splice(index, 1);
    this.farms.push(farm);
    if (this.farms.length > KNOWN_FARMS) this.farms.splice(0, this.farms.length - KNOWN_FARMS);
    this.memorize({ kind: "farm", farm });
  }

  /**
   * The hole it last dug in, for the monitor's map: a new one replaces the old, and the older notes are deleted once
   * the new one is saved (one shelter note per bot). Never part of {@link knownPlaces}: the models learn of a hole from
   * the dig's own result.
   */
  rememberShelter(hole: Omit<ShelterHole, "at">): void {
    this.shelter = { ...hole, at: new Date().toISOString() };
    this.options.log(`shelter: dug in at ${hole.x} ${hole.y} ${hole.z}, ${hole.depth} deep, ${hole.roofed ? "roofed" : "open"}`);
    this.body.act("note_save", memoryNote({ kind: "shelter", hole: this.shelter }), "Remember this across restarts.")
      .then((outcome) => outcome.status === "succeeded" ? this.forgetOlderShelters() : this.options.log(`could not save a memory (${outcome.status}): ${outcome.error ?? ""}`))
      .catch((error: unknown) => this.options.log(`could not save a shelter memory: ${String(error)}`));
  }

  /** Deletes every shelter note but the newest; a failure leaves the old notes, the monitor shows the newest anyway. */
  private async forgetOlderShelters(): Promise<void> {
    const rows = await this.options.runtime.queryBotData(shelterNotesQuery(this.options.persona.username));
    const stale = staleShelterNotes(rows);
    if (stale.length === 0) return;
    const outcome = await this.body.act("note_delete", { note_ids: stale }, "Forget the shelter hole I dug in before.");
    if (outcome.status !== "succeeded") this.options.log(`could not forget old shelter notes (${outcome.status}): ${outcome.error ?? ""}`);
  }

  /** The areas protected in this world's bot data, so the models know them from the first prompt. */
  async recallAreas(): Promise<void> {
    try {
      this.areas.push(...await this.options.runtime.protectedRegions());
      this.options.log(`knows ${this.areas.length} protected area(s)`);
    } catch (error) {
      this.options.log(`could not read its protected areas: ${String(error)}`);
    }
  }

  /** What it knew before this brain started: the memories saved as notes in this world's bot data. */
  async recallMemory(): Promise<void> {
    const limits = { places: KNOWN_PLACES, lately: OWN_MEMORY, farms: KNOWN_FARMS, times: ACTIVITY_MEMORY };
    try {
      const rows = await this.options.runtime.queryBotData(recallQuery(this.options.persona.username, limits));
      const recalled = recall(rows.map((row) => String(row[1] ?? "")), limits);
      this.places.push(...recalled.places);
      this.lately.push(...recalled.lately);
      this.farms.push(...recalled.farms);
      for (const time of recalled.times) this.spent(time, false);
      this.building.unfinished = recalled.unfinished;
      this.savedUnfinished = JSON.stringify(recalled.unfinished);
      const house = recalled.unfinished === null ? "" : `, an unfinished ${recalled.unfinished.kind}`;
      this.options.log(`remembers ${recalled.places.length} place(s), ${recalled.farms.length} farm(s), ${recalled.lately.length} own objective(s)${house}`);
    } catch (error) {
      this.options.log(`could not recall its memory: ${String(error)}`);
    }
  }

  /** Whether {@link ROTATE_EVERY_MS} have passed since the old activity notes were last deleted. */
  activityNotesDue(): boolean {
    return monotonicNow() - this.rotatedAt >= ROTATE_EVERY_MS;
  }

  /**
   * Deletes its activity-time notes older than its last hour of play (spec 2026-10-04-activity-time-travel-
   * terraforming: only the last hour is kept), at start and then every {@link ROTATE_EVERY_MS}.
   */
  async rotateActivityNotes(): Promise<void> {
    this.rotatedAt = monotonicNow();
    try {
      const rows = await this.options.runtime.queryBotData(activityNotesQuery(this.options.persona.username));
      const stale = staleActivityNotes(rows, RECENT_MINUTES);
      for (let start = 0; start < stale.length; start += DELETE_BATCH) {
        const outcome = await this.body.act("note_delete", { note_ids: stale.slice(start, start + DELETE_BATCH) }, "Forget what is older than my last hour of play.");
        if (outcome.status !== "succeeded") {
          this.options.log(`could not forget old activity notes (${outcome.status}): ${outcome.error ?? ""}`);
          return;
        }
      }
      if (stale.length > 0) this.options.log(`forgot ${stale.length} activity note(s) older than its last hour of play`);
    } catch (error) {
      this.options.log(`could not forget old activity notes: ${String(error)}`);
    }
  }

  /** Saves one memory as a note; it takes the body between steps (the runtime runs `note_save` as a task). */
  memorize(memory: Memory): void {
    this.body.act("note_save", memoryNote(memory), "Remember this across restarts.")
      .then((outcome) => {
        if (outcome.status !== "succeeded") this.options.log(`could not save a memory (${outcome.status}): ${outcome.error ?? ""}`);
      })
      .catch((error: unknown) => this.options.log(`could not save a memory: ${String(error)}`));
  }

  /** Saves the unfinished house to memory when it differs from the last saved one. */
  memorizeUnfinishedHouse(): void {
    const unfinished = JSON.stringify(this.building.unfinished);
    if (unfinished === this.savedUnfinished) return;
    this.savedUnfinished = unfinished;
    this.memorize({ kind: "unfinished_house", house: this.building.unfinished });
  }

  /** Counts a step's time towards its activity; a long enough one is remembered across restarts. */
  spent(time: ActivityTime, remember: boolean): void {
    this.times.push(time);
    this.times.splice(0, this.times.length, ...lastOfPlay(this.times));
    if (remember) this.memorize({ kind: "activity_time", time });
  }

  /** Keeps the outcome of one of its own objectives for the goal tier: the last {@link OWN_MEMORY} are kept. */
  rememberOwnOutcome(line: string): void {
    this.lately.push(line);
    if (this.lately.length > OWN_MEMORY) this.lately.splice(0, this.lately.length - OWN_MEMORY);
  }
}

/** `14 min ago` (or `just now`) from an ISO time, for the situation the models read. */
function minutesAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "some time ago";
  return minutes < 1 ? "just now" : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}
