import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { describeActionTools } from "../../../src/actions/describe.ts";
import { ACTION_COORDINATE_KEYS, ARENA_ENV, ZERO_ARENA, arenaActionInput, arenaFrame, decodeArena, encodeArena } from "./frame.ts";

const LANE_3 = { x: 0, z: 1536 };

test("an absent arena variable decodes to the zero offset, so a plain mine-labs run changes nothing", () => {
  assert.deepEqual(decodeArena({}), ZERO_ARENA);
  assert.deepEqual(decodeArena({ [ARENA_ENV]: undefined }), ZERO_ARENA);
});

test("an offset survives the client.env round trip", () => {
  assert.deepEqual(decodeArena({ [ARENA_ENV]: encodeArena(LANE_3) }), LANE_3);
});

test("a malformed arena variable throws instead of running the client at offset zero in a lane", () => {
  for (const bad of ["not json", "{}", '{"x":0}', '{"x":"0","z":1}', '{"x":0.5,"z":1}', '{"x":0,"z":1,"y":2}', "[0,1]", "null"]) {
    assert.throws(() => decodeArena({ [ARENA_ENV]: bad }), Error, bad);
  }
});

test("world and local convert a position through the offset and leave y alone", () => {
  const frame = arenaFrame(LANE_3);
  assert.deepEqual(frame.world([0.5, -60, -3]), [0.5, -60, 1533]);
  assert.deepEqual(frame.local([0.5, -60, 1533]), [0.5, -60, -3]);
  assert.deepEqual(frame.local(frame.world([12, 70, -88])), [12, 70, -88]);
  assert.deepEqual(arenaFrame(ZERO_ARENA).world([1, 2, 3]), [1, 2, 3]);
});

test("an action input shifts x and z at any depth, never y", () => {
  const input = {
    x: 3,
    y: 64,
    z: -4,
    blocks: [{ x: 1, y: 2, z: 3, block: "stone" }],
    nested: { deeper: [{ z: 10 }] },
  };
  assert.deepEqual(arenaActionInput(input, arenaFrame(LANE_3)), {
    x: 3,
    y: 64,
    z: 1532,
    blocks: [{ x: 1, y: 2, z: 1539, block: "stone" }],
    nested: { deeper: [{ z: 1546 }] },
  });
});

test("tend_crops corners x1 x2 z1 z2 shift with their own axis", () => {
  const frame = arenaFrame({ x: 512, z: 1024 });
  assert.deepEqual(arenaActionInput({ x1: 0, z1: 1, x2: 5, z2: 6, y: 2 }, frame), { x1: 512, z1: 1025, x2: 517, z2: 1030, y: 2 });
});

test("an x holding a string or a list, and numbers under other keys, are left alone", () => {
  const input = { x: "east", z: [1, 2, 3], nested: { x: null, z: true }, count: 5, block: "z", axis: "x", cell: { index: 7 } };
  assert.deepEqual(arenaActionInput(input, arenaFrame(LANE_3)), input);
});

test("an action input is copied, the caller's value keeps its numbers", () => {
  const input = { x: 1, nested: { z: 2 } };
  const shifted = arenaActionInput(input, arenaFrame(LANE_3));
  assert.deepEqual(input, { x: 1, nested: { z: 2 } });
  assert.notEqual(shifted.nested, input.nested);
});

test("a decimal coordinate keeps its decimals under a negative x offset", () => {
  const frame = arenaFrame({ x: -512, z: 0 });
  assert.deepEqual(arenaActionInput({ x: 25.5, z: -16 }, frame), { x: -486.5, z: -16 });
});

/**
 * Numeric properties named like a world coordinate whose description does not start with "Absolute". Each entry says
 * why the property is not a world coordinate (and so would be shifted wrongly): none today.
 */
const NOT_WORLD_COORDINATES: ReadonlyMap<string, string> = new Map();

/**
 * Properties that are world block positions although their description does not say "Absolute" (found by this census
 * 2026-10-23, read in each action's contract). Each is shifted into the lane on purpose.
 */
const WORLD_COORDINATES_NOT_DESCRIBED_ABSOLUTE: ReadonlyMap<string, string> = new Map([
  ["collect_block.x", "'Exact target block x': the block's world position"],
  ["collect_block.z", "'Exact target block z': the block's world position"],
  ["pick_up_items.x", "centre of the search, a world point (x, y, z together)"],
  ["pick_up_items.z", "centre of the search, a world point (x, y, z together)"],
  ["protect_region.corner_a.x", "a corner of the protected box, a world block"],
  ["protect_region.corner_a.z", "a corner of the protected box, a world block"],
  ["protect_region.corner_b.x", "a corner of the protected box, a world block"],
  ["protect_region.corner_b.z", "a corner of the protected box, a world block"],
  ["protect_region.center.x", "centre of the protected box, a world block"],
  ["protect_region.center.z", "centre of the protected box, a world block"],
  ["raw_action.x", "target of look, dig, place: a world position"],
  ["raw_action.z", "target of look, dig, place: a world position"],
  ["smelt_item.x", "'Furnace block X coordinate': the furnace's world position"],
  ["smelt_item.z", "'Furnace block Z coordinate': the furnace's world position"],
  ["use_container.x", "'Container block X coordinate': the container's world position"],
  ["use_container.z", "'Container block Z coordinate': the container's world position"],
]);

const isListed = (key: string): boolean => NOT_WORLD_COORDINATES.has(key) || WORLD_COORDINATES_NOT_DESCRIBED_ABSOLUTE.has(key);

type JsonSchema = { [key: string]: unknown };

/** Every shifted-named property of an action's input JSON schema: `[tool, path, description, isNumeric]`. */
function shiftedProperties(tool: string, schema: JsonSchema, path: string, defs: JsonSchema, seen: ReadonlySet<string>): Array<[string, string, string, boolean]> {
  const ref = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (ref !== undefined) {
    if (seen.has(ref)) return [];
    const target = defs[ref.replace("#/$defs/", "")] as JsonSchema | undefined;
    return target ? shiftedProperties(tool, target, path, defs, new Set([...seen, ref])) : [];
  }
  const found: Array<[string, string, string, boolean]> = [];
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const [name, child] of Object.entries(properties)) {
    if (ACTION_COORDINATE_KEYS.has(name)) found.push([tool, `${path}.${name}`, String(child.description ?? ""), isNumeric(child)]);
    found.push(...shiftedProperties(tool, child, `${path}.${name}`, defs, seen));
  }
  if (schema.items) found.push(...shiftedProperties(tool, schema.items as JsonSchema, `${path}[]`, defs, seen));
  for (const branch of ["anyOf", "oneOf", "allOf"] as const) {
    for (const child of (schema[branch] ?? []) as JsonSchema[]) found.push(...shiftedProperties(tool, child, path, defs, seen));
  }
  return found;
}

function isNumeric(schema: JsonSchema): boolean {
  if (schema.type === "number" || schema.type === "integer") return true;
  return (["anyOf", "oneOf", "allOf"] as const).some((branch) => ((schema[branch] ?? []) as JsonSchema[]).some(isNumeric));
}

function everyShiftedProperty(): Array<[string, string, string, boolean]> {
  return describeActionTools().flatMap((tool) => {
    const schema = z.toJSONSchema(tool.inputSchema, { io: "input" }) as JsonSchema;
    return shiftedProperties(tool.name, schema, "", (schema.$defs ?? {}) as JsonSchema, new Set());
  });
}

test("the census finds the coordinate properties it is meant to guard", () => {
  const paths = everyShiftedProperty().map(([tool, path]) => `${tool}${path}`);
  for (const expected of ["navigate.x", "navigate.z", "place_block.x", "build_structure.blocks[].x", "tend_crops.x1", "tend_crops.z2"]) {
    assert.ok(paths.includes(expected), `${expected} not found among ${paths.join(", ")}`);
  }
});

test("every numeric x/z/x1/x2/z1/z2 action input is an absolute world coordinate, or listed with its reason", () => {
  const unlisted = everyShiftedProperty()
    .filter(([, , , numeric]) => numeric)
    .filter(([tool, path, description]) => !description.startsWith("Absolute") && !isListed(`${tool}${path}`))
    .map(([tool, path, description]) => `${tool}${path}: "${description}"`);
  assert.deepEqual(unlisted, [], "arenaActionInput would shift these; reword them 'Absolute ...' or list them with the reason");
});

test("no action input names a shifted key without a number (a string or list there would be skipped silently)", () => {
  const nonNumeric = everyShiftedProperty()
    .filter(([, , , numeric]) => !numeric)
    .map(([tool, path]) => `${tool}${path}`);
  assert.deepEqual(nonNumeric, []);
});

test("every listed exception names a property the schemas still have, so the lists cannot rot", () => {
  const present = new Set(everyShiftedProperty().map(([tool, path]) => `${tool}${path}`));
  const stale = [...NOT_WORLD_COORDINATES.keys(), ...WORLD_COORDINATES_NOT_DESCRIBED_ABSOLUTE.keys()].filter((key) => !present.has(key));
  assert.deepEqual(stale, []);
});
