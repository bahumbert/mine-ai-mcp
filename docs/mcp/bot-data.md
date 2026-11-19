# Bot data and the SQL interface

Mine AI MCP uses SQLite as its world memory and inspection interface. The
database records bot vitals, carried inventory, explored chunks, container
contents, and event logs.

For schema discovery, connected-version knowledge, reusable action queries, and
result handling, see the [query guide](query-guide.md).

## Foreground executions and call history

`action_executions` retains bot-scoped action IDs and submission retry keys,
original arguments/rationale, checkpoints, terminal output, and
`resultRetrieved` state. One execution can have many MCP calls. The original
submission's `requestId` remains its incident identity; later waits have their
own call IDs. `action_responses.status` describes the call: an `accepted` reply
is not a successful world outcome and a `pending` reply is not a terminal partial.

```sql
SELECT action_id, submission_id,
       json_extract(record_json, '$.action') AS action,
       json_extract(record_json, '$.requestId') AS original_request_id,
       json_extract(record_json, '$.resultRetrieved') AS result_retrieved,
       json_extract(record_json, '$.terminal.output.result.status') AS terminal_status
FROM action_executions
ORDER BY rowid DESC LIMIT 10;
```

SQL reads do not release the result gate. Use `wait_for_action` to retrieve the
complete output; returning it releases the gate automatically. Startup
extends the old call-status constraint while preserving historical response
payloads. Persistent nonterminal executions are reconciled as interrupted
failures on restart, without replaying physical work. Temporary storage retains
only its own runtime's results.

## Resuming a stronghold search

`locate_stronghold` stores paid-for observations in `stronghold_throws`,
keyed by bot, dimension and caller-selected `search_id` within the existing
world database. Each row records the throw attempt, eye entity UUID, observed
start/end positions, compass bearing and observation state. Positions update
during flight, including after foreground cancellation. A pending row proves
an attempt, not consumption or a valid bearing. Runtime shutdown leaves any
unfinished flight marked incomplete; recorded positions remain reusable.

```sql
SELECT throw_id, search_id, state, start_json, end_json, bearing_degrees
FROM stronghold_throws
WHERE search_id = 'stronghold'
ORDER BY rowid;
```

The default `phase: "estimate"` returns the initial triangulation without
travelling. Call `phase: "locate"` with the same `search_id` after preparing
supplies; both phases reconstruct their progress from the saved throws.
No separate mutable phase row is needed.

The final `stronghold_located` event distinguishes the computed X/Z estimate
from the portal-frame block actually observed in loaded chunks. Reusing the
same `search_id` resumes the search; a different name starts an independent one.

## Where is bot data stored?

Path resolution is implemented in
[src/bot-data/sql-bot-data.ts](../../src/bot-data/sql-bot-data.ts) and
[src/bot-data/bot-data-identity.ts](../../src/bot-data/bot-data-identity.ts). By
default, persistent files live beneath `~/.mine-ai/bot-data`, configured via
`--data-root`.

Within the root directory, databases are organised by world and scope:

- Personal bot database:
  `<root>/<world segment>/bots/<bot segment>/bot-data.sqlite`
- Shared world database:
  `<root>/<world segment>/shared/bot-data.sqlite`

A segment is the identity made file-safe (up to 48 characters, with any other
character replaced by a hyphen) followed by a hyphen and the first twelve hex
digits of the identity's SHA-256 digest, so two identities that sanitise to the
same text still get different directories. The `worldId` derives from the
logical Minecraft server host, port, and the server-provided hashed world seed
in [src/bot-data/minecraft-identity.ts](../../src/bot-data/minecraft-identity.ts).
The `botId` is the player UUID assigned by Minecraft upon login.

## How is a bot-data file versioned?

`PRAGMA user_version` is the file's version. On open, the ordered steps of
[src/bot-data/migrations.ts](../../src/bot-data/migrations.ts) above the file's version run, each in its own
transaction; one `migrated` line per step goes to stderr. A file newer than the runtime is refused untouched with
`[BOT_DATA_TOO_NEW]`; a step that fails rolls back and the open fails with `[BOT_DATA_MIGRATION_FAILED] step <n>
<name>: <cause>`, and the next open retries it. The `schema_version` metadata row mirrors the version for people
reading the file. Step 1 builds the base tables, step 2 moves the brain's old memory notes into `memories`, step 3
renames the old per-bot frontier tables to `legacy_frontier_*` (see "The world file"); a background import then moves
their rows and drops them.

## The world file

The chunk scans are stored once per world, in `<world folder>/world/world-data.sqlite` beside the `bots/` and `shared/`
folders (class `SqlWorldData`, [src/bot-data/sql-world-data.ts](../../src/bot-data/sql-world-data.ts), versioned like a
bot file). Every host of the world opens it with its own connection and writes a scan in one short transaction; a write
the file's other writer holds answers "busy" at once and the recorder tries again 20-200 ms later (at most 20 tries, then
the scan error `Chunk <key>: world data busy for 20 tries`). A bot connection attaches it read-only as `world`, so a bot's
own write transactions never lock it. What a bot saw is `main.frontier_seen` (one row per bot and chunk, `bot_id` the
player name); the frontier names below are TEMP views over the sightings and the world scans, so each bot's map shows
the chunks it saw. The whole world's map is readable as `world.frontier_chunks`,
`world.frontier_chunk_materials` and `world.frontier_chunk_biomes`.

## What storage and scope modes exist?

Storage supports two persistence modes and two scope modes:

| Option      | Value        | Behaviour                                                           |
| ----------- | ------------ | ------------------------------------------------------------------- |
| Persistence | `persistent` | Reads and writes an SQLite file on disk with WAL journal mode.      |
| Persistence | `temporary`  | Creates an in-memory `:memory:` database that vanishes on shutdown. |
| Scope       | `bot`        | Isolates memory to one specific bot UUID.                           |
| Scope       | `shared`     | Shares one world database among all cooperating local bots.         |

The defaults are `persistent` and `bot`. Exploration test scenarios use
`temporary` mode to run real SQL without leaving state files behind.

## How are database locks diagnosed?

Runtime writes use synchronous `BEGIN IMMEDIATE` transactions with
`busy_timeout = 0`. Contention fails immediately so SQLite cannot stall the
Minecraft physics loop. Startup alone allows five seconds for migration and
journal setup. Shared scope allows multiple host connections to the same file;
WAL permits concurrent readers but still has only one writer at a time.

`/health` exposes `minecraft.botData.diagnostics`: the connection ID, process and
thread IDs, file, lock-failure count, and latest failure. This snapshot is held
in memory and needs no database query. It keeps the latest failure after
recovery; the full sequence is written to process stderr with the
`[minecraft-bot-data]` prefix, alongside persistent connection open/close records.

Each lock failure records the named operation, request ID where supplied by
action-response persistence, phase (`begin`, `operation`, `commit`, or cleanup),
elapsed time for that phase, transaction state, native SQLite code, and original
stack. SQL text and bound parameters are not added to these diagnostics.
`BOT_DATA_LOCKED` errors preserve the native error as their cause, and navigation
logs the stack rather than only its message. Cleanup preserves both errors if
rollback or restoring read-only access also fails.

Code `5` (`SQLITE_BUSY`) at `begin` indicates that the writer lock was unavailable.
Code `517` (`SQLITE_BUSY_SNAPSHOT`) distinguishes an old read snapshot that cannot
be upgraded after another connection commits. `transactionActive: false` does
not rule out an unfinished cursor holding an implicit read snapshot. The public
SQL query's truncated and failed iterator paths are tested against a second
writer to check that they release their cursors.

SQLite does not identify the conflicting process in these errors. Correlate the
file and timestamps with other hosts' connection records; the reported PID is
the failing connection's process, not proof of the lock holder. Do not store the
failure through the same database or retry a completed physical action because
its response could not be persisted.

## How does the data dictionary describe tables?

The database maintains a `data_dictionary` table. It is rebuilt on startup and
combines schema metadata for both the persistent `main` database and the
disposable `knowledge` database:

```sql
SELECT database_name, table_name, column_name, description
FROM data_dictionary
ORDER BY database_name, table_name, column_name;
```

A row with a `NULL` column name describes the table itself; rows with populated
column names describe individual columns.

## What tables and views does bot data provide?

The schema defined in [src/bot-data/bot-data.sql](../../src/bot-data/bot-data.sql)
exposes these tables and views:

| Name                       | Type  | Purpose                                                                           |
| -------------------------- | ----- | --------------------------------------------------------------------------------- |
| `sql_bot_data_metadata`    | Table | Stores internal database identity, schema version, and world IDs.                 |
| `bot_status`               | Table | Holds live coordinates, yaw, pitch, vitals, time of day, and weather.             |
| `bot_inventory`            | Table | Lists every carried and worn stack, slot numbers, and held status.                |
| `bot_tools`                | Table | Holds the current best item, tier, slot, and durability for every tool and armour class. |
| `events`                   | Table | Stores durable event chronologies, types, timestamps, and JSON payloads.          |
| `event_read_state`         | Table | Records the highest event ID read by each bot.                                    |
| `action_requests`          | Table | Logs incoming MCP requests, tool arguments, rationales, and timestamps.           |
| `action_responses`         | Table | Records settled MCP results, durations, and output JSON payloads.                 |
| `frontier_seen`            | Table | The chunks this bot saw: one row per bot and chunk (the player name), first-seen time. |
| `world.frontier_chunks`    | Table | In the world file: every scanned chunk column of the world, surface-water fraction, scan time. |
| `world.frontier_chunk_materials` | Table | In the world file: non-routine block materials found within each chunk column. |
| `world.frontier_chunk_biomes` | Table | In the world file: sampled biome frequencies for each chunk column.            |
| `observed_containers`      | Table | Stores the last observed complete slot layout for opened containers.              |
| `placed_containers`        | Table | Lists the containers this bot placed itself (the only ones its chest deposit uses). |
| `protected_regions`        | Table | Boxes this bot never digs or scaffolds in (ADR-012), from `protect_region`.       |
| `memories`                 | Table | Typed memories an agent saved (kind, subject, version, JSON data, a sentence), from `memory_save`. |
| `observed_container_slots` | View  | Flattens container contents into individual slot rows with item names and counts. |
| `observed_container_items` | View  | Aggregates item totals across container locations.                                |
| `frontier_chunks`          | TEMP view | The chunks this bot saw with the world's scan of each: coordinates, water fraction, `is_frontier` (1 unless all four neighbours were seen). |
| `frontier_chunk_materials` | TEMP view | Materials of the chunks this bot saw.                                         |
| `frontier_chunk_biomes`    | TEMP view | Biome samples of the chunks this bot saw.                                     |
| `frontier_map_chunks`      | TEMP view | Provides dominant biomes, all biomes, and material summaries per chunk.       |
| `frontier_navigation`      | TEMP view | Joins frontier chunks with live bot status to compute distance and heading.   |
| `knowledge.action_queries` | Table | Catalogs canonical read queries used by actions for inspection and reuse.         |

## Worked example queries

These queries demonstrate practical reads using `query_bot_data`.

### Find the closest unexplored frontier chunks

```sql
SELECT chunk_x, chunk_z, dominant_biome, distance_blocks, heading_degrees
FROM frontier_navigation
WHERE is_frontier = 1
ORDER BY distance_blocks ASC
LIMIT 5;
```

This query identifies the five closest unmapped chunk borders, showing the
biome, block distance, and compass heading to travel.

### Find remembered storage containing specific items

```sql
SELECT dimension, block_x, block_y, block_z, block_name, item_count
FROM observed_container_items
WHERE item_name = 'iron_ingot'
ORDER BY item_count DESC;
```

This query searches all remembered chests and barrels to locate iron ingots.

### Aggregate carried inventory by item count

```sql
SELECT item_name, SUM(count) AS total_count
FROM bot_inventory
GROUP BY item_name
ORDER BY total_count DESC;
```

This query totals carried items across all inventory slots.

## What safety bounds govern model queries?

Queries executed through `query_bot_data` must satisfy strict bounds
enforced by
[src/actions/query-bot-data/query-bot-data.ts](../../src/actions/query-bot-data/query-bot-data.ts):

- **Read-only enforcement**: Queries run with `PRAGMA query_only = ON`. An
  SQLite authorizer permits only `SQLITE_SELECT`, `SQLITE_READ`,
  `SQLITE_FUNCTION`, and `SQLITE_RECURSIVE`. Modification statements, table
  creation, and schema alterations are rejected.
- **Single statement**: Exactly one `SELECT` or `WITH` statement is permitted.
  Multiple semicolon-separated statements are rejected.
- **Statement size limit**: The SQL query text may not exceed 16 KiB
  (`QUERY_BOT_DATA_MAX_SQL_BYTES = 16384`).
- **Row limit**: Output is capped at 100 rows (`QUERY_BOT_DATA_MAX_ROWS = 100`).
  Results exceeding this limit are truncated with `truncated: true`.
- **Payload byte limit**: JSON-serialized output is capped at 64 KiB
  (`QUERY_BOT_DATA_MAX_RESULT_BYTES = 65536`).
- **Synchronous execution**: Queries execute synchronously on the host thread.
  Unbounded complex queries cannot be interrupted mid-flight, so callers must
  keep model queries focused.
