// What the agent knows and keeps across restarts: known places, farms, protected areas, its own outcomes, activity time, the unfinished house.
import { forgetOldActivityNotes } from "../activity-note-rotation.ts";
import type { AgentOptions } from "../agent.ts";
import type { Body } from "../body.ts";
import { resumeStep } from "../building/templates.ts";
import { describeGrowthSince, describeStage, GROWTH_REACH, READING_GAP_MS, type Near } from "../farming/growth.ts";
import type { KnownPlace } from "../mind.ts";
import { memoryNote, recall, recallQuery, shelterNotesQuery, staleShelterNotes, type KnownFarm, type Memory, type Recalled, type ShelterHole } from "../memory.ts";
import { minutesAgo } from "../minutes-ago.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { Position, ProtectedArea } from "../runtime-client.ts";
import type { UnfinishedHouse } from "../skills.ts";
import { lastOfPlay, type ActivityTime } from "../time-spent.ts";
import { UnfinishedHouseSaver } from "../unfinished-house-saver.ts";

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

/** A position reading and the per-farm intervals since its last tend; never persisted across a restart. */
interface FarmReading { readonly position: Position; readonly dimension: string; readonly at: number }
interface FarmNearTime { readonly started: number; reading: FarmReading | null; near: number; unknown: number }

/** Growth reach is horizontal from the middle of the farm's chunk, including negative coordinates (T1 facts). */
function isNearFarm(farm: KnownFarm, reading: FarmReading): boolean {
  const x = Math.floor(farm.centre.x / 16) * 16 + 8;
  const z = Math.floor(farm.centre.z / 16) * 16 + 8;
  return farm.dimension === reading.dimension && Math.hypot(reading.position.x - x, reading.position.z - z) <= GROWTH_REACH;
}

/** A known farm's observed state, growth since its tend and the action that harvests and replants it. */
function farmPlace(farm: KnownFarm, near: Near | null, at: number, explainDry: boolean): KnownPlace {
  const growth = describeStage(farm.state);
  const since = Math.max(0, Math.round((at - Date.parse(farm.tendedAt)) / 60_000));
  const dry = (farm.state.dry ?? 0) > 0 ? `; ${farm.state.dry} dry farmland${explainDry ? " (grows slower; water within 4 blocks hydrates it)" : ""}` : "";
  const counts = `${farm.state.planted} planted, ${farm.state.ripe} ripe, ${farm.state.empty} empty`;
  const detail = farm.state.stage === undefined
    ? `${counts}${growth === "" ? "" : `, ${growth}`} when you last tended it, ${minutesAgo(farm.tendedAt)}`
    : `${farm.state.planted} planted/${farm.state.ripe} ripe/${farm.state.empty} empty; ${describeGrowthSince(farm, since, near)}${dry}`;
  // Modern farms omit the repeated action guide: the work tier's farm skill already states it (master 2026-11-09).
  const action = farm.state.stage === undefined ? "; farming it again harvests what is ripe and replants it" : "";
  return {
    name: `your ${farm.crop} farm`,
    detail: `${farm.size}x${farm.size} around ${farm.centre.x} ${farm.centre.y} ${farm.centre.z}; ${detail}${action}`,
  };
}

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
  /** Saves the unfinished house to memory when it changed (also while a step runs: a throw skips the save after it). */
  readonly unfinishedSaver = new UnfinishedHouseSaver((house) => this.memorize({ kind: "unfinished_house", house }), () => this.building.unfinished);
  /** When old activity notes were last deleted. */
  private rotatedAt = Number.NEGATIVE_INFINITY;
  private readonly farmNearTime = new Map<KnownFarm, FarmNearTime>();
  private lastPosition: FarmReading | null = null;

  constructor(private readonly options: Pick<AgentOptions, "runtime" | "log" | "persona">, private readonly body: Body) {}

  /**
   * The places shown to the models: the known ones, and the unfinished house with where to stand to resume it (live
   * 2026-10-02: asked to "go back and finish the house you started", she began a new one where she stood).
   */
  knownPlaces(): KnownPlace[] {
    // Her farms, as they were at their last tend: the models only know what the situation says (when to come back is
    // their choice).
    // One general hydration explanation covers every farm; keep each farm's own dry count.
    const dryFarm = this.farms.find((farm) => farm.state.stage !== undefined && (farm.state.dry ?? 0) > 0);
    const farms = this.farms.map((farm) => farmPlace(farm, this.nearMinutes(farm), Date.now(), farm === dryFarm));
    const house = this.building.unfinished;
    if (house === null) return [...this.places, ...farms];
    const { x, y, z } = house.site.door;
    return [...this.places, ...farms, { name: `your unfinished ${house.kind}`, detail: `door ${x} ${y} ${z}; ${resumeStep(house)} walks there and goes on with it` }];
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
    const previous = this.farms[index];
    if (previous !== undefined && farm.pace === undefined && previous.pace !== undefined) farm = { ...farm, pace: previous.pace };
    if (previous !== undefined && farm.paceFresh === undefined && previous.paceFresh !== undefined) farm = { ...farm, paceFresh: previous.paceFresh };
    if (index >= 0) this.farms.splice(index, 1);
    this.farms.push(farm);
    if (this.farms.length > KNOWN_FARMS) this.farms.splice(0, this.farms.length - KNOWN_FARMS);
    const started = monotonicNow();
    const tally = previous?.tendedAt === farm.tendedAt ? this.farmNearTime.get(previous) : undefined;
    this.farmNearTime.set(farm, tally ?? { started, reading: this.lastPosition, near: 0, unknown: 0 });
    for (const known of this.farmNearTime.keys()) if (!this.farms.includes(known)) this.farmNearTime.delete(known);
    this.memorize({ kind: "farm", farm });
  }

  /** Credits only intervals whose endpoints were sampled, short enough, in the same dimension and within reach. */
  notePosition(position: Position, dimension: string, atMs: number): void {
    const reading = { position: { ...position }, dimension, at: atMs };
    this.lastPosition = reading;
    for (const [farm, tally] of this.farmNearTime) {
      const previous = tally.reading;
      // Keep the real sample gap, but credit only time after the tend (task review, 2026-11-09).
      const elapsed = atMs - Math.max(previous?.at ?? tally.started, tally.started);
      if (elapsed < 0) continue;
      if (previous === null || atMs - previous.at > READING_GAP_MS) tally.unknown += elapsed / 60_000;
      else if (isNearFarm(farm, previous) && isNearFarm(farm, reading)) tally.near += elapsed / 60_000;
      tally.reading = reading;
    }
  }

  /** A recalled farm has no process-local baseline; an unsampled tail remains unknown until another reading. */
  nearMinutes(farm: KnownFarm): Near | null {
    const tally = this.farmNearTime.get(farm);
    if (tally === undefined || farm.dimension === undefined) return null;
    const now = monotonicNow();
    const tail = Math.max(0, now - Math.max(tally.reading?.at ?? tally.started, tally.started)) / 60_000;
    return { near: tally.near, unknown: tally.unknown + (tail * 60_000 > READING_GAP_MS ? tail : 0), since: Math.max(0, now - tally.started) / 60_000 };
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

  /** What it knew before this brain started: the memories saved as notes in this world's bot data. Returns what was recalled (conversations and relations are the agent's to load), null when the read failed. */
  async recallMemory(): Promise<Recalled | null> {
    const limits = { places: KNOWN_PLACES, lately: OWN_MEMORY, farms: KNOWN_FARMS, times: ACTIVITY_MEMORY };
    try {
      const rows = await this.options.runtime.queryBotData(recallQuery(this.options.persona.username, limits));
      const recalled = recall(rows.map((row) => String(row[1] ?? "")), limits);
      this.places.push(...recalled.places);
      this.lately.push(...recalled.lately);
      this.farms.push(...recalled.farms);
      for (const time of recalled.times) this.spent(time, false);
      this.building.unfinished = recalled.unfinished;
      this.unfinishedSaver.known(recalled.unfinished);
      const house = recalled.unfinished === null ? "" : `, an unfinished ${recalled.unfinished.kind}`;
      this.options.log(`remembers ${recalled.places.length} place(s), ${recalled.farms.length} farm(s), ${recalled.lately.length} own objective(s)${house}${recalled.gone.map((line) => `; ${line}`).join("")}`);
      this.lately.push(...recalled.gone); // what the model reads about its own past: a house it can no longer finish
      return recalled;
    } catch (error) {
      this.options.log(`could not recall its memory: ${String(error)}`);
      return null;
    }
  }

  /** Whether {@link ROTATE_EVERY_MS} have passed since the old activity notes were last deleted. */
  activityNotesDue(): boolean {
    return monotonicNow() - this.rotatedAt >= ROTATE_EVERY_MS;
  }

  /** Deletes its activity-time notes older than its last hour of play, at start and then every {@link ROTATE_EVERY_MS}. */
  async rotateActivityNotes(): Promise<void> {
    this.rotatedAt = monotonicNow();
    await forgetOldActivityNotes(this.options.runtime, this.body, this.options.persona.username, this.options.log);
  }

  /** Saves one memory as a note; it takes the body between steps (the runtime runs `note_save` as a task). Resolves whether the note was saved; never rejects. */
  memorize(memory: Memory): Promise<boolean> {
    return this.body.act("note_save", memoryNote(memory), "Remember this across restarts.")
      .then((outcome) => {
        if (outcome.status !== "succeeded") this.options.log(`could not save a memory (${outcome.status}): ${outcome.error ?? ""}`);
        return outcome.status === "succeeded";
      })
      .catch((error: unknown) => {
        this.options.log(`could not save a memory: ${String(error)}`);
        return false;
      });
  }

  /** Saves the unfinished house to memory when it differs from the last saved one. */
  memorizeUnfinishedHouse(): void {
    this.unfinishedSaver.request();
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
