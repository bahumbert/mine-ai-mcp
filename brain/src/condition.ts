// The bounded condition line shared by every prompt with a Situation block.
import type { KnownPlace } from "./mind.ts";
import type { BotSnapshot } from "./runtime-client.ts";
import { sameDimension } from "./bot-data-sql.ts";
import { cut } from "./prompt-budget.ts";
import { distanceBetween } from "./skills/positions.ts";

/** Server messages and stored names cannot create a second prompt line. */
function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

/** The bot's own home, if any. */
export function homeOf(places: readonly KnownPlace[], snapshot: BotSnapshot): string {
  const own = places.filter((place) => place.own === true);
  if (own.length === 0) return "no home";
  if (!sameDimension(snapshot.dimension, "overworld")) return "home in the overworld";
  const distances = own.flatMap((place) => place.house === undefined ? [] : [distanceBetween(snapshot.position, place.house.door)]);
  return distances.length === 0 ? `home: ${JSON.stringify(oneLine(own[0]!.name))}` : `home ${Math.round(Math.min(...distances))} blocks away`;
}

/** One decimal at most, keeping a living bot's fractional health. */
function decimal(value: number): string {
  return String(Number(value.toFixed(1)));
}

/** Worn slots and carried pieces are separate facts; best carried gear does not say what is worn. */
function armourSegments(snapshot: BotSnapshot): string[] {
  if (snapshot.armour === undefined) return [];
  const { worn, carried } = snapshot.armour;
  const points = typeof snapshot.armourPoints === "number" ? `${snapshot.armourPoints} points${(snapshot.armourToughness ?? 0) > 0 ? `, toughness ${snapshot.armourToughness}` : ""} ` : "";
  const slots = worn.slice(0, 4);
  const armour = slots.every((entry) => entry.item === null) ? "armour: none worn" : `armour ${points}worn: ${slots.map(({ slot, item }) => `${slot} ${item ?? "none"}`).join(", ")}`;
  const items = carried.slice(0, 4).map(({ item, count }) => count > 1 ? `${count} ${item}` : item);
  if (carried.length > 4) items.push(`and ${carried.length - 4} more`);
  return items.length === 0 ? [armour] : [armour, `carried, not worn: ${items.join(", ")}`];
}

/** What the fight reflex can take by itself, as the runtime reports it. */
function combatSegment(combat: NonNullable<BotSnapshot["combat"]>): string {
  const items = [combat.melee ?? "bare hands"];
  if (combat.bow !== null) items.push(combat.arrows > 0 ? `${combat.bow} with ${combat.arrows} arrows` : `${combat.bow} (no arrows: not used)`);
  if (combat.shield !== null) items.push(combat.shield);
  return `your fight reflex uses by itself: ${items.join(", ")}`;
}

/** Light stays unknown when no data arrived; tools are relevant whenever the known sky light is below 15. */
function lightSegments(snapshot: BotSnapshot): string[] {
  const light = snapshot.light;
  if (light === undefined) return [];
  const segments: string[] = [];
  if (light.sky !== null || light.block !== null) segments.push(`light here: sky ${light.sky ?? "?"}, block ${light.block ?? "?"}`);
  if (light.openSkyAbove !== null) segments.push(`open sky ${light.openSkyAbove} blocks above`);
  if (light.sky !== null && light.sky < 15) {
    const tools = (snapshot.gear?.tools ?? []).slice(0, 12).flatMap(({ item }) => item === null ? [] : [item]);
    segments.push(`tools: ${tools.length === 0 ? "none (digging by hand)" : tools.join(", ")}`);
  }
  return segments;
}

/** The last death's age and place, with a bounded single-line server message. */
function deathSegment(death: NonNullable<BotSnapshot["lastDeath"]>, dimension: string): string {
  const age = death.minutesAgo >= 120 ? `${Math.floor(death.minutesAgo / 60)} h` : `${Math.floor(death.minutesAgo)} min`;
  const { x, y, z } = death.position;
  const elsewhere = sameDimension(death.dimension, dimension) ? "" : ` in ${death.dimension}`;
  const cause = death.cause === null ? "" : `: ${cut(oneLine(death.cause), 120)}`;
  return `last death ${age} ago at ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}${elsewhere}${cause}`;
}

/** The facts of the bot's body, equipment and surroundings as one prompt line. */
export function conditionLine(snapshot: BotSnapshot, places: readonly KnownPlace[]): string {
  const food = snapshot.foods.reduce((sum, entry) => sum + entry.points * entry.count, 0);
  const saturation = snapshot.saturation === undefined ? "" : ` (saturation ${decimal(snapshot.saturation)})`;
  const segments = [`health ${decimal(snapshot.health)}/20, food ${snapshot.food}/20${saturation}, ${food > 0 ? `carried food ${food} points` : "no food carried"}`];
  if (snapshot.burn != null) segments.push(`burning: about ${Math.round(snapshot.burn.ticks / 20)} s left (~${snapshot.burn.hp} hp)`);
  segments.push(...armourSegments(snapshot));
  if (snapshot.combat !== undefined) segments.push(combatSegment(snapshot.combat));
  if (snapshot.clock?.phase != null && snapshot.clock.minutesUntilChange !== null) segments.push(`it is ${snapshot.clock.phase} now, ${snapshot.clock.phase === "day" ? "night" : "day"} comes in ${snapshot.clock.minutesUntilChange.toFixed(1)} min`);
  segments.push(...lightSegments(snapshot), homeOf(places, snapshot));
  if (snapshot.respawn != null) {
    const kind = snapshot.respawn.kind === "bed" ? "bed" : "world spawn";
    segments.push(`respawn: ${kind} ${snapshot.respawn.distance === null ? "in another dimension" : `${Math.round(snapshot.respawn.distance)} blocks away`}`);
  }
  if (snapshot.lastDeath != null) segments.push(deathSegment(snapshot.lastDeath, snapshot.dimension));
  return `- Condition: ${segments.join("; ")}.`;
}
