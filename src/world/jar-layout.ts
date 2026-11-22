/**
 * Where a server jar keeps its data files, for the extractors (`*-extract.ts`). The folders were renamed in 1.21: tags
 * lived in plural folders (`tags/items`, `tags/blocks`, `tags/entity_types`) and recipes in `recipes/` up to 1.20.6, and
 * live in singular ones (`tags/item`, `tags/block`, `tags/entity_type`, `recipe/`) from 1.21 (measured in the 1.19.4,
 * 1.20.1, 1.20.4, 1.20.6, 1.21.1 and 1.21.4 jars).
 */

/** The three registries a tag file can hold ids of; the name is the singular folder. */
export type TagKind = "block" | "item" | "entity_type";

/** Both folder names of a tag kind, singular first. */
export const tagFolderNames = (kind: TagKind): readonly [string, string] => [kind, `${kind}s`];

/** A jar path of a vanilla tag of `kind`, either folder spelling; the capture is the tag name (`mineable/axe`). */
export const tagFilePattern = (kind: TagKind): RegExp =>
  new RegExp(`^data/minecraft/tags/(?:${tagFolderNames(kind).join("|")})/(.+)\\.json$`, "u");

/** The tags a recipe's ingredient can name are item tags. */
export const INGREDIENT_TAG_KIND: TagKind = "item";

/** Both jar paths a tag `path` of `namespace` can have for `kind`: the plural folder spelling and the singular one. */
export const tagFilePaths = (kind: TagKind, namespace: string, path: string): readonly string[] =>
  tagFolderNames(kind).map((folder) => `data/${namespace}/tags/${folder}/${path}.json`);

/** A jar path of a damage type file (`data/minecraft/damage_type/mob_attack.json`); the capture is the type name. Damage types are data from 1.19.4 on (measured in the 1.19.4, 1.20.1 and 1.21.4 jars: `damage_type/`, singular, each file with `scaling`). */
export const DAMAGE_TYPE_FILE = /^data\/minecraft\/damage_type\/([^/]+)\.json$/u;

/** A jar path of a recipe file, either folder spelling. */
export const RECIPE_FILE = /^data\/minecraft\/recipes?\/[^/]+\.json$/u;
