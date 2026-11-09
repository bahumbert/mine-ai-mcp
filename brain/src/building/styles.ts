import { existsSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { OPTIONAL_ROLES, ROLES, type BlockRole, type OptionalRole, type Palette, type RequiredRole, type Variants } from "./blueprint.ts";
import { ROOFS } from "./house.ts";

// check-reads: brain/building-styles/*.json
export const blockId = z.string().regex(/^[a-z0-9_]+$/u, "a Minecraft block id such as oak_planks").refine((id) => id !== "air", "air is not a material");
export const kebabId = z.string().regex(/^[a-z0-9-]+$/u, "kebab-case id");
const blockRoles = ROLES.filter((role): role is BlockRole => role !== "air");
const isOptional = (role: BlockRole): role is OptionalRole => (OPTIONAL_ROLES as readonly BlockRole[]).includes(role);

/** Per role, its stairs and slab blocks (ADR-013): a stair roof needs `roof`'s; a role without them builds full blocks. */
export const variantsSchema = z.partialRecord(z.enum(blockRoles), z.strictObject({ stairs: blockId.optional(), slab: blockId.optional() }));

/** A building style, as data (ADR-006): the persona's taste (its family of houses and a description). Still carries the classic generator's palette until the classic houses are files only. */
export const styleSchema = z.strictObject({
  id: kebabId,
  /** The family of house templates the persona lists first in its prompt (`brain/building-templates/`). */
  family: kebabId,
  description: z.string().trim().min(1).max(200),
  palette: z.strictObject({
    ...(Object.fromEntries(blockRoles.filter((role) => !isOptional(role)).map((role) => [role, blockId])) as Record<RequiredRole, typeof blockId>),
    ...(Object.fromEntries(OPTIONAL_ROLES.map((role) => [role, blockId.optional()])) as Record<OptionalRole, z.ZodOptional<typeof blockId>>),
  }),
  variants: variantsSchema.optional(),
  house: z.strictObject({ roof: z.enum(ROOFS), overhang: z.number().int().min(0).max(2) }),
});

export type Style = z.infer<typeof styleSchema> & { readonly palette: Palette; readonly variants?: Variants };

/**
 * The first folder called `name` (`building-styles`, `building-templates`) at or above the folder of `from`. The source
 * (`brain/src/building/`) and the setup's bundle (`brain/src/main.js`: a bundled module's `import.meta.url` is its entry
 * file's) both reach `brain/`.
 */
export function findDataDirectory(name: string, from: URL, levels = 4): URL {
  let folder = new URL(".", from);
  for (let level = 0; level < levels; level++) {
    if (existsSync(new URL(`${name}/`, folder))) return new URL(`${name}/`, folder);
    folder = new URL("../", folder);
  }
  throw new Error(`[DATA_FOLDER_MISSING] no ${name}/ folder at or within ${levels - 1} levels above ${from.href}: the app folder is incomplete, run it from a checkout or install that ships brain/${name}/.`);
}

/** Where the style files live; one JSON file per style, named after its id. */
export const STYLES_DIRECTORY = findDataDirectory("building-styles", new URL(import.meta.url));

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
