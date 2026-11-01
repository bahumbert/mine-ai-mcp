import { existsSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ROLES, type BlockRole, type Palette, type Variants } from "./blueprint.ts";
import { ROOFS } from "./house.ts";

// check-reads: brain/building-styles/*.json
const blockId = z.string().regex(/^[a-z0-9_]+$/u, "a Minecraft block id such as oak_planks").refine((id) => id !== "air", "air is not a material");
const blockRoles = ROLES.filter((role): role is BlockRole => role !== "air");

/** A building style, as data (ADR-006): which block plays each role, and the shape choices of its generators. */
export const styleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/u, "kebab-case id"),
  description: z.string().trim().min(1).max(200),
  palette: z.strictObject(Object.fromEntries(blockRoles.map((role) => [role, blockId])) as Record<BlockRole, typeof blockId>),
  /** Per role, its stairs and slab blocks (ADR-013): a stair roof needs `roof`'s; a role without them builds full blocks. */
  variants: z.partialRecord(z.enum(blockRoles), z.strictObject({ stairs: blockId.optional(), slab: blockId.optional() })).optional(),
  house: z.strictObject({ roof: z.enum(ROOFS), overhang: z.number().int().min(0).max(2) }),
});

export type Style = z.infer<typeof styleSchema> & { readonly palette: Palette; readonly variants?: Variants };

const STYLES_FOLDER = "building-styles";

/**
 * The first `building-styles/` folder at or above the folder of `from`. The source (`brain/src/building/`) and the
 * setup's bundle (`brain/src/main.js`: a bundled module's `import.meta.url` is its entry file's) both reach `brain/`.
 */
export function findStylesDirectory(from: URL, levels = 4): URL {
  let folder = new URL(".", from);
  for (let level = 0; level < levels; level++) {
    if (existsSync(new URL(`${STYLES_FOLDER}/`, folder))) return new URL(`${STYLES_FOLDER}/`, folder);
    folder = new URL("../", folder);
  }
  throw new Error(`[STYLE_INVALID] no ${STYLES_FOLDER}/ folder at or within ${levels - 1} levels above ${from.href}`);
}

/** Where the style files live; one JSON file per style, named after its id. */
export const STYLES_DIRECTORY = findStylesDirectory(new URL(import.meta.url));

export function loadStyles(directory: URL = STYLES_DIRECTORY): ReadonlyMap<string, Style> {
  const styles = new Map<string, Style>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const parsed = styleSchema.safeParse(JSON.parse(readFileSync(new URL(file, directory), "utf8")));
    if (!parsed.success) throw new Error(`[STYLE_INVALID] ${file}: ${z.prettifyError(parsed.error)}`);
    if (`${parsed.data.id}.json` !== file) throw new Error(`[STYLE_INVALID] ${file}: id "${parsed.data.id}" does not match the file name`);
    styles.set(parsed.data.id, parsed.data);
  }
  if (styles.size === 0) throw new Error(`[STYLE_INVALID] no style file in ${directory.pathname}`);
  return styles;
}

/** The styles shipped in `brain/building-styles/`, loaded once. */
export const STYLES = loadStyles();

/** Used when neither the request nor the persona names a known style. */
export const DEFAULT_STYLE = "medieval";
