import { readFileSync } from "node:fs";

// check-reads: src/bot-data/bot-data.sql
export const BOT_DATA_SCHEMA = readFileSync(new URL("./bot-data.sql", import.meta.url), "utf8");
