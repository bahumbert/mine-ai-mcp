/** The shared fake Mineflayer bot, its clock, server, world and inventory (spec `2026-10-21-shared-fake-bot`). */
export { type FakeBot, type FakeBotOptions, type FakeEntitySpec, type FakeHarness, createFakeBot } from "./fake-bot.js";
export { type FakeBreath, type FakeBreathParts } from "./fake-bot-breath.js";
export { type FakeClock, type FakeClockMode, type FakeClockOptions, createFakeClock, failIfFakeClockLeftInstalled, flush } from "./fake-clock.js";
export { EQUIPMENT_SLOTS, type FakeInventory, type FakeInventoryOptions, createFakeInventory, itemOf } from "./fake-inventory.js";
export { type FakeServer, type FakeServerOptions, type ReceivedPacket, createFakeServer } from "./fake-server.js";
export { type FakeCell, type FakeWorld, type FakeWorldOptions, blockUpdateEventOf, createFakeWorld } from "./fake-world.js";
export { type ChunkCoords, DEFAULT_LOADED_CHUNK_RADIUS, type FakeColumn, type ListedColumn } from "./fake-world-columns.js";
