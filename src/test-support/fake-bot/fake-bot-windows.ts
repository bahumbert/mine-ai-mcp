/**
 * The fake bot's windows: `clickWindow`, `transfer` and the container windows, which are Mineflayer's own
 * `inventory.js` and `chest.js`, installed on a scratch object that borrows the bot (as `fake-bot-find-blocks.ts` does
 * for `blocks.js`). Its handlers listen on the fake client, so the server's `set_slot`, `window_items` and `open_window`
 * (`fake-window-server.ts`) reach the bot through Mineflayer's own code, and its clicks and transfers are the library's.
 */
import type { Bot } from "mineflayer";
import { createRequire } from "node:module";
import type { FakeBot } from "./fake-bot.js";
import type { FakeInventory } from "./fake-inventory.js";
import { type FakeWindowServer, type FakeWindows, LOGIN_PLAYER_STATE_ID, createWindowServer } from "./fake-window-server.js";
import type { FakeServer } from "./fake-server.js";
import type { FakeWorld } from "./fake-world.js";

const require = createRequire(import.meta.url);

/** The hotbar's first window slot (`simple_inventory.js:6`). */
const QUICK_BAR_START = 36;

type Plugin = (scratch: object, options: { hideErrors: boolean }) => void;
type WindowApi = Pick<
  Bot,
  "clickWindow" | "closeWindow" | "putAway" | "putSelectedItemRange" | "transfer" | "moveSlotItem" | "openBlock" | "openContainer" | "openChest" | "openDispenser" | "updateHeldItem"
>;

/**
 * Install `inventory.js` (windows, clicks, transfers; its `activateBlock` serves `openBlock` and is not put on the bot: using other blocks is not answered here) and `chest.js` on a scratch object that borrows the
 * bot's registry, client, inventory, current window and look. What the plugins write to the scratch about the bot's
 * own inventory, quick bar and hand (they create a window of their own and a null quick bar slot) is dropped: the bot's are the
 * fake inventory's.
 */
function installWindowPlugins(bot: FakeBot): WindowApi {
  // During the install the plugins' own player window stands for `bot.inventory`: the listeners they put on it there are dropped with it.
  let ownWindow: unknown;
  let installing = true;
  const borrowed = {
    registry: bot.registry,
    version: bot.version,
    supportFeature: bot.supportFeature,
    _client: bot._client,
    QUICK_BAR_START,
    // Getters, so a game, entity, inventory or window a test replaces afterwards reaches the plugin.
    get game() {
      return bot.game;
    },
    get entity() {
      return bot.entity;
    },
    get food() {
      return bot.food;
    },
    get lastDigTime() {
      return (bot as Bot & { lastDigTime?: number | null }).lastDigTime;
    },
    get inventory() {
      return installing ? ownWindow : bot.inventory;
    },
    set inventory(window: unknown) {
      ownWindow = window;
    },
    get heldItem() {
      return bot.heldItem;
    },
    get quickBarSlot() {
      return bot.quickBarSlot;
    },
    set quickBarSlot(_unset: unknown) {},
    get currentWindow() {
      return bot.currentWindow;
    },
    set currentWindow(window: Bot["currentWindow"]) {
      bot.currentWindow = window;
    },
    get usingHeldItem() {
      return bot.usingHeldItem;
    },
    set usingHeldItem(using: boolean) {
      bot.usingHeldItem = using;
    },
    lookAt: (...args: Parameters<Bot["lookAt"]>) => bot.lookAt(...args),
    swingArm: (...args: Parameters<Bot["swingArm"]>) => bot.swingArm(...args),
    setQuickBarSlot: (...args: Parameters<Bot["setQuickBarSlot"]>) => bot.setQuickBarSlot(...args),
    // The bot's events are the scratch's: `windowOpen`, `windowClose`, `heldItemChanged`, `setWindowItems:<id>`.
    on: bot.on.bind(bot),
    addListener: bot.addListener.bind(bot),
    once: bot.once.bind(bot),
    off: bot.off.bind(bot),
    removeListener: bot.removeListener.bind(bot),
    emit: bot.emit.bind(bot),
  };
  const scratch = Object.defineProperties({}, Object.getOwnPropertyDescriptors(borrowed));
  const listeningBefore = new Set(bot._client.listeners("window_items"));
  (require("mineflayer/lib/plugins/inventory.js") as Plugin)(scratch, { hideErrors: true });
  (require("mineflayer/lib/plugins/chest.js") as Plugin)(scratch, { hideErrors: true });
  installing = false;
  // The state id the login's `window_items` would have told the client (`inventory.js:34-38`: its first `window_items` listener only files the id).
  const [fileStateId] = bot._client.listeners("window_items").filter((listener) => !listeningBefore.has(listener));
  fileStateId?.({ windowId: 0, stateId: LOGIN_PLAYER_STATE_ID });
  return scratch as WindowApi;
}

/** The parts of a window whose changes are the client's own prediction: a click accepted, and the player's part copied back at the close. */
interface PredictingWindow {
  acceptClick(...args: unknown[]): unknown;
  close?: () => unknown;
}

/** The window's own close (`inventory.js:377-382`, set again by `openBlock` after `windowOpen`): its copy of the player's part is the client's prediction. */
function predictedClose(window: PredictingWindow, windows: FakeWindowServer): void {
  const close = window.close?.bind(window);
  if (close !== undefined) window.close = () => windows.predict(close);
}

/**
 * Mark the client's predictions on the bot's inventory and on every window it opens, so the fake server, which applies each
 * click itself one answer later, does not take the prediction for a change the game made (`inventory.js:626-706` accepts a
 * click before writing it; `:445-467` copies the window's player part into `bot.inventory` at the close).
 */
function followClientPredictions(bot: FakeBot, windows: FakeWindowServer): void {
  const predicted = (window: PredictingWindow) => {
    const accept = window.acceptClick.bind(window);
    window.acceptClick = (...args) => windows.predict(() => accept(...args));
  };
  predicted(bot.inventory as unknown as PredictingWindow);
  bot.on("windowOpen", (window) => predicted(window as unknown as PredictingWindow));
}

/** The windows are installed at the first call: the plugins add some thirty client listeners, which most tests never need. */
export function attachFakeWindows(
  bot: FakeBot,
  parts: { server: FakeServer; world: FakeWorld; inventory: FakeInventory; containers: Readonly<Record<string, Readonly<Record<string, number>>>> },
): FakeWindows {
  const windows: FakeWindowServer = createWindowServer(bot, parts);
  let installed: WindowApi | undefined;
  const api = () => {
    if (installed === undefined) {
      installed = installWindowPlugins(bot);
      followClientPredictions(bot, windows);
    }
    return installed;
  };
  // The client's own prediction of a click or a close is not what the server's record follows: it applies the click itself.
  const forwarded: WindowApi = {
    clickWindow: (...args) => windows.predict(() => api().clickWindow(...args)),
    closeWindow: (...args) => windows.predict(() => api().closeWindow(...args)),
    putAway: (...args) => api().putAway(...args),
    putSelectedItemRange: (...args) => api().putSelectedItemRange(...args),
    transfer: (...args) => api().transfer(...args),
    moveSlotItem: (...args) => api().moveSlotItem(...args),
    openBlock: async (...args) => predicted(await api().openBlock(...args)),
    openContainer: async (...args) => predicted(await api().openContainer(...args)),
    openChest: async (...args) => predicted(await api().openChest(...args)),
    openDispenser: async (...args) => predicted(await api().openDispenser(...args)),
    updateHeldItem: () => api().updateHeldItem(),
  };
  Object.assign(bot, forwarded);
  /** A window handed to the caller closes as a prediction (its `close` is the plugin's, set after `windowOpen`). */
  function predicted<T>(window: T): T {
    predictedClose(window as PredictingWindow, windows);
    return window;
  }
  return windows;
}
