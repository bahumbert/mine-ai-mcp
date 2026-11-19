// Text imports, not file reads: the setup's bundle inlines them (a bundled module has no `.sql` file beside it).
// check-reads: src/bot-data/world-data.sql, src/bot-data/frontier-views.sql
/// <reference path="./sql-text.d.ts" />
import frontierViews from "./frontier-views.sql" with { type: "text" };
import worldSchema from "./world-data.sql" with { type: "text" };

export const WORLD_DATA_SCHEMA: string = worldSchema;
export const FRONTIER_VIEWS: string = frontierViews;
