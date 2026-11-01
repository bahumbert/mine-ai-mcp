// A text import, not a file read: the setup's bundle inlines it (a bundled module has no `bot-data.sql` beside it).
// check-reads: src/bot-data/bot-data.sql
/// <reference path="./sql-text.d.ts" />
import schema from "./bot-data.sql" with { type: "text" };

export const BOT_DATA_SCHEMA: string = schema;
