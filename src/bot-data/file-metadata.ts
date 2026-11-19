// The identity rows (`sql_bot_data_metadata`) of a bot-data or world-data file, and the check that the file is the one asked for.
import type { DatabaseSync } from "node:sqlite";

/** Reject incompatible files before schema installation can modify them. */
export function validateExistingMetadata(database: DatabaseSync, expected: ReadonlyMap<string, string>): void {
  const metadataTable = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sql_bot_data_metadata'")
    .get();
  if (metadataTable === undefined) return;

  const find = database.prepare("SELECT value FROM sql_bot_data_metadata WHERE key = ?");
  for (const [key, expectedValue] of expected) {
    const existing = find.get(key) as { value: string } | undefined;
    if (existing !== undefined && existing.value !== expectedValue) {
      throw metadataMismatch(key, expectedValue, existing.value);
    }
  }
}

/** Writes the identity rows once and compares them after; `schema_version` mirrors `user_version` for people reading the file. */
export function installAndValidateMetadata(database: DatabaseSync, expected: ReadonlyMap<string, string>): void {
  const find = database.prepare("SELECT value FROM sql_bot_data_metadata WHERE key = ?");
  const insert = database.prepare("INSERT INTO sql_bot_data_metadata (key, value) VALUES (?, ?)");
  const version = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

  // A file that already holds every row needs no write: opening it must not queue behind another host's write lock (the
  // world file is shared, and a host opens it after its bot is connected). A mismatch still throws below.
  const wanted = new Map(expected).set("schema_version", String(version));
  const upToDate = [...wanted].every(([key, value]) => (find.get(key) as { value: string } | undefined)?.value === value);
  if (upToDate) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        "INSERT INTO sql_bot_data_metadata (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(version));
    for (const [key, expectedValue] of expected) {
      const existing = find.get(key) as { value: string } | undefined;
      if (existing === undefined) {
        insert.run(key, expectedValue);
      } else if (existing.value !== expectedValue) {
        throw metadataMismatch(key, expectedValue, existing.value);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function metadataMismatch(key: string, expected: string, actual: string): Error {
  return new Error(
    `SQL bot data identity mismatch for ${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}.`,
  );
}
