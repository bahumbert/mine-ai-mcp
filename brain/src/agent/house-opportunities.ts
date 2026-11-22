// The things a character could do now, with the facts about a house of its own that the goal tier needs to choose among them.
import type { Activity } from "../activities.ts";
import { shortfall } from "../building/blueprint.ts";
import { ownSmallHouse, rolesOf, temporaryHouseLack } from "../building/house-facts.ts";
import { findOpportunities, type Opportunity, type OpportunityFacts, type Shortfall } from "../opportunities.ts";
import type { BotRuntime, BotSnapshot } from "../runtime-client.ts";
import type { AgentMemory } from "./agent-memory.ts";
import type { GameFacts } from "./game-facts.ts";

/** Carried full blocks named to the goal tier as materials a house could use. */
const MAX_CARRIED_BLOCKS = 5;

/** What the opportunities are worked out from: what the agent knows, the game facts, the runtime, the persona's style. */
interface OpportunitySource {
  readonly memory: AgentMemory;
  readonly facts: GameFacts;
  readonly runtime: BotRuntime;
  readonly style: string | undefined;
  readonly log: (line: string) => void;
}

/** Things that could use doing now (the tasks a character looks for); the goal tier decides what to make of them. */
export async function opportunitiesFor(source: OpportunitySource, snapshot: BotSnapshot, drawn: readonly Activity[], trading: Pick<OpportunityFacts, "tradeNeeds" | "heardNeeds"> = {}): Promise<Opportunity[]> {
  const { memory } = source;
  const ownHome = memory.places.some((place) => place.own === true);
  const unfinished = memory.building.unfinished;
  let houseShortfallFacts: Shortfall[] = [];
  let smallHouse: OpportunityFacts["smallHouse"] = [];
  let carriedBlockFacts: OpportunityFacts["carriedBlocks"] = [];
  let temporaryHouse: OpportunityFacts["temporaryHouse"] = null;
  try {
    if (!ownHome && unfinished === null) {
      houseShortfallFacts = await houseShortfall(source, snapshot);
      smallHouse = rolesOf(ownSmallHouse(source.style, snapshot.position));
      carriedBlockFacts = await carriedBlocks(source, snapshot);
    }
    temporaryHouse = await temporaryHouseFacts(source);
  } catch (error) {
    source.log(`could not work out what a house of its own needs: ${String(error)}`);
  }
  return findOpportunities({ now: Date.now(), snapshot, farms: memory.farms, nearMinutes: (farm) => memory.nearMinutes(farm), unfinished, ownHome, houseShortfall: houseShortfallFacts, smallHouse, carriedBlocks: carriedBlockFacts, temporaryHouse, ...trading }, drawn);
}

/** The most carried blocks that fill a whole cell (what `build` may use for a wall, floor or roof), at most five. */
async function carriedBlocks(source: OpportunitySource, snapshot: BotSnapshot): Promise<OpportunityFacts["carriedBlocks"]> {
  const kinds = await source.facts.kindsOf(snapshot.inventory.map((stack) => stack.name));
  const counts = new Map<string, number>();
  for (const stack of snapshot.inventory) if (kinds.get(stack.name)?.fullCube === true) counts.set(stack.name, (counts.get(stack.name) ?? 0) + stack.count);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, MAX_CARRIED_BLOCKS);
}

/** Its temporary own house, which roles are temporary, and what improving them needs beyond what it carries. */
async function temporaryHouseFacts(source: OpportunitySource): Promise<OpportunityFacts["temporaryHouse"]> {
  const place = source.memory.temporaryHouse();
  const house = place?.house;
  if (house === undefined) return null;
  const lack = temporaryHouseLack(house, (await source.runtime.status()).inventory);
  return lack === null ? null : { door: lack.door, roles: lack.roles, shortfall: await source.facts.withActivities(lack.missing) };
}

/** What her small house needs beyond what she carries, each with the work that gets it. */
async function houseShortfall(source: OpportunitySource, snapshot: BotSnapshot): Promise<Shortfall[]> {
  const bill = ownSmallHouse(source.style, snapshot.position)?.bill ?? [];
  return source.facts.withActivities(shortfall(bill, snapshot.inventory));
}
