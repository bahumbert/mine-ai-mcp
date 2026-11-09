// The house templates: JSON files of layers of role cells with their own palette, loaded into one registry and cut into build stages.
import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { stackSizeOf } from "../newest-registry.ts";
import { billOfMaterials, blueprintSchema, BUILD_ROLES, cellsCountedOnce, describeMaterials, FACINGS, placeBlueprint, ROLES, SHAPES, type BlockRole, type Blueprint, type Variants, type WorldCell } from "./blueprint.ts";
import { blockId, DEFAULT_STYLE, findDataDirectory, kebabId, STYLES, variantsSchema } from "./styles.ts";
import { groupEntryOf, supportGroups, validateBlueprint, type SupportGroup } from "./support.ts";

// check-reads: brain/building-templates/*.json

/** The two sizes of a persona's own classic house (`{"skill":"build","size":"small"}`). */
export const CLASSIC_SIZES = ["small", "medium"] as const;
export type ClassicSize = (typeof CLASSIC_SIZES)[number];

/** Inventory stacks a stage may ask for at once: half of the 36 slots. */
export const STAGE_STACKS = 18;

/** A run of `build_structure` calls (inclusive indexes into a plan's batches) the bot fetches the blocks for and builds together. */
export interface Stage {
  readonly name: string;
  readonly first: number;
  readonly last: number;
}

/** A house the bots can build: its shape and palette, from one JSON file. */
export interface Template {
  readonly id: string;
  readonly family: string;
  readonly name: string;
  readonly description: string;
  /** The display name kept in notes and protected-area labels; the template's `name`. */
  readonly kind: string;
  readonly blueprint: Blueprint;
  readonly palette: Partial<Record<BlockRole, string>>;
  readonly variants: Variants;
  /** Declared stages: each `top` is the highest blueprint layer a stage holds. Absent: derived from the batches. */
  readonly stages?: readonly { readonly name: string; readonly top: number }[];
  /** Set by the six classic files only: the style and size they were exported from. */
  readonly classic?: { readonly style: string; readonly size: ClassicSize };
}

const cellKind = z.strictObject({
  role: z.enum(ROLES),
  shape: z.enum(SHAPES).optional(),
  facing: z.enum(FACINGS).optional(),
  half: z.enum(["top", "bottom"]).optional(),
  axis: z.enum(["x", "y", "z"]).optional(),
});

const templateFileSchema = z.strictObject({
  id: kebabId,
  family: kebabId,
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(200),
  palette: z.strictObject(Object.fromEntries(BUILD_ROLES.map((role) => [role, blockId.optional()])) as Record<BlockRole, z.ZodOptional<typeof blockId>>),
  variants: variantsSchema.optional(),
  key: z.record(z.string().length(1), cellKind),
  layers: z.array(z.array(z.string().min(1)).min(1)).min(1),
  stages: z.array(z.strictObject({ name: z.string().trim().min(1).max(20), top: z.number().int().min(0) })).min(1).optional(),
  classic: z.strictObject({ style: kebabId, size: z.enum(CLASSIC_SIZES) }).optional(),
});
type TemplateFile = z.infer<typeof templateFileSchema>;

const invalid = (file: string, reason: string) => new Error(`[TEMPLATE_INVALID] ${file}: ${reason}`);

/** The blueprint a file's layers write: `layers[y][z][x]`, `.` and a space are no cell, any other character is a `key` entry. */
function blueprintOfLayers(file: string, data: TemplateFile): Blueprint {
  for (const char of Object.keys(data.key)) if (char === "." || char === " ") throw invalid(file, `key "${char}": a key character is neither "." nor a space, those are no cell`);
  const rows = data.layers[0]?.length ?? 0;
  const width = data.layers[0]?.[0]?.length ?? 0;
  const cells: Blueprint["cells"] = [];
  data.layers.forEach((layer, y) => {
    if (layer.length !== rows) throw invalid(file, `layer ${y} has ${layer.length} rows, layer 0 has ${rows}: every layer has the same number of rows.`);
    layer.forEach((row, z) => {
      if (row.length !== width) throw invalid(file, `layer ${y} row ${z} has ${row.length} characters, the first row has ${width}: every row has the same length.`);
      [...row].forEach((char, x) => {
        if (char === "." || char === " ") return;
        const kind = data.key[char];
        if (kind === undefined) throw invalid(file, `"${char}" (layer ${y} row ${z} column ${x}) is not in key.`);
        cells.push({ x, y, z, ...kind });
      });
    });
  });
  const parsed = blueprintSchema.safeParse({ name: data.name, size: { x: width, y: data.layers.length, z: rows }, cells });
  if (!parsed.success) throw invalid(file, z.prettifyError(parsed.error));
  return parsed.data;
}

/** The highest support group of the blueprint (its layer, with the front facing north and the door at its own cell). */
function highestGroup(blueprint: Blueprint, data: TemplateFile): number {
  const anchor = blueprint.cells.find((cell) => cell.role === "door");
  if (anchor === undefined) return 0;
  const placed = placeBlueprint(blueprint, data.palette, anchor, "north", data.variants);
  const { groups } = supportGroups(placed);
  return Math.max(0, ...placed.filter((cell) => cell.role !== "air" && cell.role !== "door").map((cell) => groups.get(`${cell.x},${cell.y},${cell.z}`)?.group ?? 0));
}

/** Declared stages rise strictly, the last at or above the highest group, so every call belongs to one. */
function stageProblem(blueprint: Blueprint, data: TemplateFile): string | null {
  const tops = (data.stages ?? []).map((stage) => stage.top);
  if (tops.some((top, index) => index > 0 && top <= tops[index - 1]!)) return `stages: the tops must rise strictly, they are ${tops.join(", ")}.`;
  const highest = highestGroup(blueprint, data);
  if (tops.length > 0 && tops.at(-1)! < highest) return `stages: the last top is ${tops.at(-1)}, below the highest layer ${highest}: the last stage must reach it.`;
  return null;
}

function parseTemplateFile(file: string, text: string): Template {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw invalid(file, `not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = templateFileSchema.safeParse(json);
  if (!parsed.success) throw invalid(file, z.prettifyError(parsed.error));
  const data = parsed.data;
  if (`${data.id}.json` !== file) throw invalid(file, `id "${data.id}" does not match the file name.`);
  const blueprint = blueprintOfLayers(file, data);
  const problems = validateBlueprint(blueprint, data.palette, data.variants ?? {});
  if (problems.length > 0) throw invalid(file, problems.join(" "));
  const staging = stageProblem(blueprint, data);
  if (staging !== null) throw invalid(file, staging);
  return {
    id: data.id, family: data.family, name: data.name, description: data.description, kind: data.name,
    blueprint, palette: data.palette, variants: data.variants ?? {},
    ...(data.stages !== undefined && { stages: data.stages }),
    ...(data.classic !== undefined && { classic: data.classic }),
  };
}

/** Where the template files live: one JSON file per template, named after its id. */
export const TEMPLATES_DIRECTORY = findDataDirectory("building-templates", new URL(import.meta.url));

/** Loads every template file of `directory`; the first bad file stops it with `[TEMPLATE_INVALID] <file>: <reason>`. */
export function loadTemplates(directory: URL = TEMPLATES_DIRECTORY): ReadonlyMap<string, Template> {
  const templates = new Map<string, Template>();
  const fileOfName = new Map<string, string>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const template = parseTemplateFile(file, readFileSync(new URL(file, directory), "utf8"));
    const same = fileOfName.get(template.name);
    if (same !== undefined) throw invalid(file, `name "${template.name}" is also the name of ${same}: a name (the kind of notes and areas) is one house.`);
    fileOfName.set(template.name, file);
    templates.set(template.id, template);
  }
  return templates;
}

/** The templates shipped in `brain/building-templates/`, loaded once. */
export const TEMPLATES = loadTemplates();

export function templateFor(id: string, templates: ReadonlyMap<string, Template> = TEMPLATES): Template | undefined {
  return templates.get(id);
}

/** The template whose `name` is `kind` (the display name old notes and protected areas carry). */
export function templateOfKind(kind: string, templates: ReadonlyMap<string, Template> = TEMPLATES): Template | undefined {
  return [...templates.values()].find((template) => template.kind === kind);
}

/** A persona's classic house of `size`; an unknown or absent style falls back to the default style, as `styleOrDefault` does. */
export function classicTemplate(style: string | undefined, size: ClassicSize, templates: ReadonlyMap<string, Template> = TEMPLATES): Template | undefined {
  const known = (style === undefined ? undefined : STYLES.get(style)) ?? STYLES.get(DEFAULT_STYLE);
  return [...templates.values()].find((template) => template.classic !== undefined && template.classic.style === known?.id && template.classic.size === size);
}

/** The template an old or new record of a house stands for: by its `template`, else its `kind`, else its style and size. */
export function templateOfHouse(house: { readonly template?: string; readonly kind?: string; readonly style?: string; readonly size?: string }, templates: ReadonlyMap<string, Template> = TEMPLATES): Template | undefined {
  if (house.template !== undefined) return templateFor(house.template, templates);
  if (house.kind !== undefined) return templateOfKind(house.kind, templates);
  const size = CLASSIC_SIZES.find((candidate) => candidate === house.size);
  return size === undefined ? undefined : classicTemplate(house.style, size, templates);
}

/** The families of `templates`, sorted. */
export function familiesOf(templates: ReadonlyMap<string, Template>): string[] {
  return [...new Set([...templates.values()].map((template) => template.family))].sort();
}

/** One line the model reads to choose a house: id, footprint, floors, blocks, the three largest bill items, description. */
export function catalogueLine(template: Template): string {
  const origin = { x: 0, y: 0, z: 0 };
  const cells = placeBlueprint(template.blueprint, template.palette, origin, "north", template.variants);
  const bill = billOfMaterials(cells);
  const floors = new Set(cells.filter((cell) => cell.role === "floor").map((cell) => cell.y)).size;
  const blocks = bill.reduce((sum, { count }) => sum + count, 0);
  const { x, z } = template.blueprint.size;
  return `${template.id} (${x}x${z}, ${floors} floor${floors === 1 ? "" : "s"}, ${blocks} blocks: ${describeMaterials(bill.slice(0, 3))}) ${template.description}`;
}

/** Whether a call is the closing pass: the air clearing or the door's. */
const isFinishBatch = (batch: readonly WorldCell[]) => batch.every((cell) => cell.role === "air") || batch.some((cell) => cell.role === "door");

/** The first batch of the trailing run of closing calls. */
function finishStart(batches: readonly (readonly WorldCell[])[]): number {
  let start = batches.length;
  while (start > 0 && isFinishBatch(batches[start - 1]!)) start -= 1;
  return start;
}

const indexFrom = (batches: readonly (readonly WorldCell[])[], from: number, end: number, test: (batch: readonly WorldCell[]) => boolean): number => {
  for (let index = from; index < end; index += 1) if (test(batches[index]!)) return index;
  return end;
};

const onlyFoundationOrFloor = (batch: readonly WorldCell[]) => batch.every((cell) => cell.role === "air" || cell.role === "foundation" || cell.role === "floor");

function isMostlyRoof(batch: readonly WorldCell[]): boolean {
  const placed = batch.filter((cell) => cell.role !== "air");
  return placed.filter((cell) => cell.role === "roof").length * 2 > placed.length;
}

/** "floor": the leading calls of foundation and floor only; "roof" from the first call of mostly roof; "walls" between; empty stages dropped. */
function derivedStages(batches: readonly (readonly WorldCell[])[], end: number): Stage[] {
  const floorEnd = indexFrom(batches, 0, end, (batch) => !onlyFoundationOrFloor(batch));
  const roofStart = indexFrom(batches, floorEnd, end, isMostlyRoof);
  return [
    { name: "floor", first: 0, last: floorEnd - 1 },
    { name: "walls", first: floorEnd, last: roofStart - 1 },
    { name: "roof", first: roofStart, last: end - 1 },
  ].filter((stage) => stage.first <= stage.last);
}

/** Declared stages: each call goes to the first stage whose `top` reaches its layer; calls of one stage are contiguous. */
function declaredStages(template: Template, batches: readonly (readonly WorldCell[])[], groups: ReadonlyMap<string, SupportGroup>, end: number): Stage[] {
  const declared = template.stages ?? [];
  const anchor = template.blueprint.cells.find((cell) => cell.role === "door");
  const door = batches.flat().find((cell) => cell.role === "door");
  const base = door === undefined || anchor === undefined ? 0 : door.y - anchor.y;
  const stages: Stage[] = [];
  for (let index = 0; index < end; index += 1) {
    const sample = batches[index]![0]!;
    const layer = (groupEntryOf(sample, groups)?.group ?? sample.y) - base;
    const found = declared.findIndex((stage) => layer <= stage.top);
    const name = declared[found === -1 ? declared.length - 1 : found]!.name;
    const previous = stages.at(-1);
    if (previous?.name === name) stages[stages.length - 1] = { ...previous, last: index };
    else stages.push({ name, first: index, last: index });
  }
  return stages;
}

/** Item counts of the cells of one call, added to `into`. */
function addCounts(into: ReadonlyMap<string, number>, cells: readonly WorldCell[]): Map<string, number> {
  const counts = new Map(into);
  for (const { item, count } of billOfMaterials(cells)) counts.set(item, (counts.get(item) ?? 0) + count);
  return counts;
}

/** Inventory stacks the counted items fill (stack sizes from the registry, 64 when it does not say). */
const stacksOf = (counts: ReadonlyMap<string, number>) => [...counts].reduce((sum, [item, count]) => sum + Math.ceil(count / (stackSizeOf(item) ?? 64)), 0);

/** A stage needing more than `STAGE_STACKS` stacks is cut at call boundaries into "<name> k/n"; a single call stays whole. */
function cutByStacks(stages: readonly Stage[], counted: readonly (readonly WorldCell[])[]): Stage[] {
  return stages.flatMap((stage) => {
    const parts: { first: number; last: number }[] = [];
    let first = stage.first;
    let counts = new Map<string, number>();
    for (let index = stage.first; index <= stage.last; index += 1) {
      const next = addCounts(counts, counted[index]!);
      if (index > first && stacksOf(next) > STAGE_STACKS) {
        parts.push({ first, last: index - 1 });
        first = index;
        counts = addCounts(new Map(), counted[index]!);
      } else counts = next;
    }
    parts.push({ first, last: stage.last });
    return parts.length === 1 ? [stage] : parts.map((part, index) => ({ name: `${stage.name} ${index + 1}/${parts.length}`, ...part }));
  });
}

/**
 * The stages of a plan's calls: the template's declared ones (the closing calls join the last), else floor, walls, roof
 * and finish derived from the calls; each over `STAGE_STACKS` stacks is cut at a call boundary. Contiguous, covering
 * every call.
 */
export function stagesOf(template: Template, batches: readonly (readonly WorldCell[])[], groups: ReadonlyMap<string, SupportGroup>): Stage[] {
  const closing = finishStart(batches);
  const lastBatch = batches.length - 1;
  const staged = template.stages === undefined
    ? [...derivedStages(batches, closing), ...(closing < batches.length ? [{ name: "finish", first: closing, last: lastBatch }] : [])]
    : declaredStages(template, batches, groups, closing).map((stage, index, all) => (index === all.length - 1 ? { ...stage, last: lastBatch } : stage));
  return cutByStacks(staged, cellsCountedOnce(batches));
}
