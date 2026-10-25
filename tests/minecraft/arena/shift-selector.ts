/** Moving one command word that may name a player or select entities: renames, shifts selector x z, boxes unpositioned selectors in the lane. */
import { isNumberWord } from "./command-tokens.ts";
import { Refusal, shiftCoordinateWord, type ShiftWalk } from "./shift-walk.ts";

const SELECTOR = /^@([aeprs])(?:\[(.*)\])?$/su;

/** A selector word (`@a`, `@e[type=zombie]`), a player name, or any other word: what the lane shift does to each. */
export function shiftWord(word: string, walk: ShiftWalk): string {
  if (word.startsWith("@")) return shiftSelector(word, walk);
  if (POSITION_IN_DATA.test(word)) throw new Refusal(`'${word}' holds a position inside NBT or an item component, which the lane shift does not move`);
  return walk.context.renames.get(word) ?? word;
}

/** NBT keys and item components that hold block or world positions (entity Pos, HomePos, BeamTarget, lodestone_tracker...). */
export const POSITION_IN_DATA = /(?:\b[Pp]os\b|\b[XYZ]\s*:|HomePos|BeamTarget|ExitPortal|Spawn[XYZ]|Sleeping[XYZ]|\bLeash\b|lodestone_tracker|last_death_location)/u;

interface SelectorFacts {
  readonly hasX: boolean;
  readonly hasY: boolean;
  readonly hasZ: boolean;
  readonly hasVolume: boolean;
  readonly hasDistance: boolean;
  /** `distance=N`, `..N` or `M..N` have an upper bound; `M..` has none. */
  readonly hasBoundedDistance: boolean;
}

function shiftSelector(word: string, walk: ShiftWalk): string {
  const match = SELECTOR.exec(word);
  if (!match) throw new Refusal(`'${word}' is not a selector the lane shift can read`);
  const type = match[1]!;
  const args = splitSelectorArguments(match[2] ?? "").map((argument) => shiftArgument(argument, walk));
  const facts = factsOf(args);
  const boxed = needsBox(type, facts, walk, word) ? [...args, boxArguments(walk)] : args;
  return boxed.length === 0 ? `@${type}` : `@${type}[${boxed.join(",")}]`;
}

/** Arguments split at commas outside nested brackets, braces and quotes. */
function splitSelectorArguments(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const char of inner) {
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

function shiftArgument(argument: string, walk: ShiftWalk): string {
  const split = argument.indexOf("=");
  if (split < 0) return argument;
  const key = argument.slice(0, split);
  const value = argument.slice(split + 1);
  if (key === "x" || key === "z") {
    if (!isNumberWord(value)) throw new Refusal(`selector ${key}=${value} is not a number`);
    return `${key}=${shiftCoordinateWord(value, key, walk)}`;
  }
  if (key === "name") return `name=${renamedName(value, walk)}`;
  return argument;
}

/** `Actor`, `!Actor`, `"Actor"`, `!"Actor"`: the name renamed, the negation and quotes kept. */
function renamedName(value: string, walk: ShiftWalk): string {
  const [, negation = "", quote = "", name = value] = /^(!?)(["']?)(.*)\2$/u.exec(value) ?? [];
  return `${negation}${quote}${walk.context.renames.get(name) ?? name}${quote}`;
}

function factsOf(args: readonly string[]): SelectorFacts {
  const keys = new Set(args.map((argument) => argument.split("=")[0]));
  return {
    hasX: keys.has("x"),
    hasY: keys.has("y"),
    hasZ: keys.has("z"),
    hasVolume: keys.has("dx") || keys.has("dy") || keys.has("dz"),
    hasDistance: keys.has("distance"),
    hasBoundedDistance: args.some((argument) => /^distance=(?!.*\.\.$)/u.test(argument)),
  };
}

/**
 * Whether a selector gets the lane cell box. A selector with its own x and z keeps them (a tick command block runs at
 * y -63 and a tick function at the world spawn, so a tick selector must also say y); one with neither is boxed unless
 * it is `@s` or measures `distance` from an executor that is already in the lane.
 */
function needsBox(type: string, facts: SelectorFacts, walk: ShiftWalk, word: string): boolean {
  if (facts.hasX !== facts.hasZ) throw new Refusal(`'${word}' gives ${facts.hasX ? "x" : "z"} without ${facts.hasX ? "z" : "x"}: the other axis would reach every lane`);
  if (facts.hasX) {
    if (walk.context.where === "tick" && !facts.hasY) throw new Refusal(`'${word}' has x and z but no y: a command block and a tick function would not run at the same height`);
    if (type !== "s" && !facts.hasVolume && !facts.hasBoundedDistance) {
      throw new Refusal(`'${word}' gives x, y and z without dx, dy, dz or a distance with an upper bound: they only move the origin, so it would select in every lane`);
    }
    return false;
  }
  if (facts.hasY) throw new Refusal(`'${word}' gives y without x and z`);
  if (facts.hasVolume) throw new Refusal(`'${word}' gives dx, dy or dz without x, y and z: the volume would start where the command runs`);
  if (facts.hasDistance) {
    if (!walk.inLane) throw new Refusal(`'${word}' measures distance from where the command runs, which is not the lane (use it after 'at')`);
    if (type !== "s" && !facts.hasBoundedDistance) throw new Refusal(`'${word}' has a distance with no upper bound: it would select in every lane (give 'distance=..N')`);
    return false;
  }
  return type !== "s";
}

/** The lane cell as x/y/z/dx/dy/dz selector arguments: the full build height over the cell's x and z. */
function boxArguments(walk: ShiftWalk): string {
  const { minX, maxX, minZ, maxZ } = walk.context.cell;
  return `x=${minX},y=-64,z=${minZ},dx=${maxX - minX},dy=383,dz=${maxZ - minZ}`;
}
