// The scene the use_container tests stand in: a bot beside a container block on the shared fake bot, its store and the action's stubbed dependencies.
import type { TestContext } from "node:test";
import { Vec3 } from "vec3";
import { type UseContainerDependencies, useContainer } from "../actions/use-container/use-container.js";
import { temporaryBotData } from "./bot-data.js";
import { setCarriedCount } from "./carried-counts.js";
import { type ContainerStack, createFakeBot } from "./fake-bot/index.js";

/** The container block's cell, beside a bot standing at the origin. */
export const CELL = "1,64,1";
/** Long enough for any call of these tests on the fake clock, which only moves while a test lets it. */
const CALL_MS = 120_000;
/** A server answer (a close, a click) lands one slice after the call that sent it. */
const SERVER_CATCH_UP_MS = 100;

/** The server's container at CELL, as the old scripted window exposed it: what it holds, what it was asked, whether it was closed. */
function containerOf(harness: ReturnType<typeof createFakeBot>) {
  const { windows, server } = harness;
  return {
    get contents(): ContainerStack[] {
      return windows.containerStacks(CELL);
    },
    set contents(stacks: readonly ContainerStack[]) {
      windows.setContainerStacks(CELL, stacks);
    },
    /** The window was closed by the bot (`close_window` written). */
    get closed(): boolean {
      return server.packets.some(({ name }) => name === "close_window");
    },
    /** Clicks the bot sent: each is a move of a stack. */
    get moves(): number {
      return server.packets.filter(({ name }) => name === "window_click").length;
    },
  };
}

/** The bot beside a container block at 1,64,1: the fake server holds the stacks and opens the window (Mineflayer's own `openContainer`). */
function testBot(
  blockName: string,
  contents: readonly ContainerStack[] | number,
  carried: Readonly<Record<string, number>> = { cobblestone: 10 },
) {
  const harness = createFakeBot({
    username: "StorageBot",
    position: new Vec3(0, 64, 0),
    cells: { [CELL]: blockName },
    carried,
    containers: { [CELL]: {} },
  });
  const container = containerOf(harness);
  const stacks: readonly ContainerStack[] = typeof contents === "number" ? (contents === 0 ? [] : [{ slot: 0, name: "cobblestone", count: contents }]) : contents;
  if (blockName === "chest" || blockName === "barrel") container.contents = stacks;
  return { harness, container };
}

const testDependencies = {
  navigate: async () => ({ status: "completed", elapsedMs: 0 }),
  createMovements: () => ({}),
  now: () => new Date("2026-08-24T00:00:00.000Z"),
} as unknown as UseContainerDependencies;

/** One container, one bot and one disposable store, with the call the subject is asked to make. */
export function scene(
  t: TestContext,
  {
    block = "chest",
    contents = 0,
    carried,
  }: { block?: string; contents?: readonly ContainerStack[] | number; carried?: Readonly<Record<string, number>> } = {},
) {
  const data = temporaryBotData({ closeAfter: t });
  const { harness, container } = testBot(block, contents, carried);
  const { bot, inventory, clock } = harness;
  /** A call of the action, run on the fake clock until it ends, with the server's last answer (the close) delivered. */
  const settled = async <T>(call: Promise<T>): Promise<T> => {
    try {
      return await clock.settle(call, CALL_MS);
    } finally {
      await clock.advance(SERVER_CATCH_UP_MS);
    }
  };
  /** The action's dependencies on this scene: the stubs above, and the harness clock for the waits on the server's answers to a click. */
  const dependencies: UseContainerDependencies = { ...testDependencies, waitTiming: clock };
  const use = (
    request: Parameters<typeof useContainer>[2],
    options: Parameters<typeof useContainer>[3] = {},
    overriding: UseContainerDependencies = dependencies,
  ) => settled(useContainer(bot, data, request, options, overriding));
  const carriedOf = (name: string) => inventory.count(bot.registry.itemsByName[name]!.id, null);
  /** Change what the bot carries of `name` by `delta`, as the server redraws the slots (`setCarriedCount`). */
  const addCarried = (name: string, delta: number) => setCarriedCount(inventory, bot.registry, bot.registry.itemsByName[name]!.id, carriedOf(name) + delta);
  return { data, container, harness, bot, use, settled, dependencies, carried: carriedOf, addCarried };
}

