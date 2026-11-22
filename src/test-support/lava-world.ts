/**
 * Lava in a planner world for the tests that read it (`MemoryWorld`). Its own module, not part of `navigation.ts`: it loads the fake
 * bot's registry, which takes seconds to import, and `navigation.ts` is imported by a test fixture that runs in a child process
 * (`continuation-abort.fixture.ts`, 5 s test timeout).
 */
import type { MemoryWorld } from "../navigation/world/memory-world.js";
import { createFakeBot } from "./fake-bot/index.js";

const { registry } = createFakeBot().bot;

/** Lava of `level` (0 source .. 7 flowing, 8 falling) loaded at `position`, with the traits the planner reads. */
export function lavaAt(world: MemoryWorld, position: { x: number; y: number; z: number }, level: number): void {
  world.load(position, {
    stateId: registry.blocksByName.lava.minStateId + level,
    collisionShapes: [],
    traits: { empty: true, liquid: "lava", liquidSource: level === 0, liquidLevel: level, damaging: true },
  });
}
