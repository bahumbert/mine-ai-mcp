/**
 * The server's side of windows: the player window and the one container window it keeps open, the clicks it applies
 * with Prismarine's own `acceptClick`, and the packets it answers with (`set_slot` for each slot the client's claim got
 * wrong, `set_cursor_item` when the cursor is, `window_items` for a stale state id, `open_window` then `window_items` for a
 * container). Stacks are told apart by their components (`sameItemVariant`). Measured on a 1.21.4 server by the contract
 * checks `click-window-hotbar-swap`, `click-window-shift-move`, `click-window-onto-variant`, `click-window-variant-split` and `chest-open-take-close`.
 */
import type { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Item } from "prismarine-item";
import type { WindowsExports } from "prismarine-windows";
import { Vec3 } from "vec3";
import type { FakeBot } from "./fake-bot.js";
import type { ServerEntities } from "./fake-bot-entities.js";
import { sameItemVariant } from "../../world/item-variant.js";
import { type FakeInventory, type FakeSlot, itemOf, stacksOf } from "./fake-inventory.js";
import { itemWithCount, stackNameOf } from "./item-variants.js";
import { type ClickableWindow, type ClickItems, installVariantClicks } from "./fake-window-clicks.js";
import { type QuickMoveItems, quickMove } from "./fake-quick-move.js";
import type { FakeServer } from "./fake-server.js";
import type { FakeWorld } from "./fake-world.js";

const require = createRequire(import.meta.url);

/** A stack of a container, by its slot. */
export interface ContainerStack extends Required<FakeSlot> {
  readonly slot: number;
}

/** What a test reads and sets of the server's windows. */
export interface FakeWindows {
  /** The server's stacks in the container at `cell` ("x,y,z"), by slot, a variant under its `ITEM_VARIANTS` name; an open window's moves reach them when it closes. */
  containerStacks(cell: string): ContainerStack[];
  /** Replace what the server holds in the container at `cell` (another bot emptied it, or filled a slot); an open window gets each changed slot as `set_slot`, as the server tells a viewer another player's change. */
  setContainerStacks(cell: string, stacks: readonly ContainerStack[]): void;
  /**
   * Run `listener` as each `window_click` reaches the server, just after its own answer is queued: what the listener queues with `server.answer`
   * (another player's change through `setContainerStacks`, `closeOpenWindow`, an abort) happens after this click and before the next one, whatever
   * the server's lag; a lagging server holds every click a bot writes without waiting until it answers. Returns the remover.
   */
  onClickReceived(listener: (click: { readonly slot: number; readonly mouseButton: number; readonly mode: number }) => void): () => void;
  /** The server closes the window it has open (the chest broken, a plugin's close): `close_window`, then the stack in hand goes back to the inventory. No effect when none is open. */
  closeOpenWindow(): void;
  /** The id of the window the server has open for the bot, or null. */
  readonly openWindowId: number | null;
  /** Whether using the block at `location` opens a window (a container the harness holds): it is not a placement. */
  opensWindowAt(location: Vec3): boolean;
}

/** The client side asks the server to follow the client's inventory from now on, and to leave out its own prediction. */
export interface FakeWindowServer extends FakeWindows {
  /** Start following the client's inventory (idempotent), then run `prediction` without the server's record following it. */
  predict<T>(prediction: () => T): T;
}

/** The menu a block opens when used, by prismarine-windows' key (`facts` 1.21.4: chest, barrel and hopper sizes). */
const MENU_OF_BLOCK: Readonly<Record<string, string>> = {
  chest: "minecraft:generic_9x3",
  trapped_chest: "minecraft:generic_9x3",
  barrel: "minecraft:generic_9x3",
  shulker_box: "minecraft:shulker_box",
  dispenser: "minecraft:generic_3x3",
  dropper: "minecraft:generic_3x3",
  hopper: "minecraft:hopper",
};
/** Vanilla numbers the windows it opens 1 to 100 and starts over (`ServerPlayer.nextContainerCounter`). */
const LAST_WINDOW_ID = 100;
/** The player window's main and hotbar slots, which every container window repeats after its own slots. */
const PLAYER_MAIN_START = 9;
const PLAYER_SLOT_COUNT = 36;
/** `blockInteractionRange` 4.5 plus the 1.0 the server adds (`Player.canInteractWithBlock`), and the server's own cap on the distance to the block's centre. */
const REACH = 5.5;
const MAX_CENTRE_DISTANCE = 8;
const EYE_HEIGHT = 1.62;
/** The state id the server holds for the player window when the bot has just logged in: its login `window_items` told the client (any value; a click with another is stale). */
export const LOGIN_PLAYER_STATE_ID = 1;
/** Where a stack given back by a close appears when nothing takes it: the same height as a toss (`fake-bot-items.ts`). */
const DROP_HEIGHT = 1.32;
/** The pickup delay of a dropped stack: a toss's, measured by contract check `tossed-item-kept-before-delay`; a close's is unmeasured. */
const DROP_PICKUP_DELAY_TICKS = 40;
/** `Inventory.add` tries the hotbar's slots (36-44 of the player window) before the main ones (9-35). */
const GIVE_BACK_ORDER = [...Array.from({ length: 9 }, (_, index) => 36 + index), ...Array.from({ length: 27 }, (_, index) => PLAYER_MAIN_START + index)];
/** `window_click` mode 1: the shift click. */
const SHIFT_CLICK = 1;

type Notch = unknown;

/** The window as the server drives it: Prismarine's, with the click applied by the library. */
interface ServerWindow extends EventEmitter, ClickableWindow {
  readonly id: number;
  readonly slots: (Item | null)[];
  readonly type: string | number;
  readonly inventoryStart: number;
  readonly inventoryEnd: number;
  acceptClick(click: { slot: number; mouseButton: number; mode: number; windowId: number; item: Item | null }): void;
}

/** The `window_click` packet as Mineflayer writes it for 1.17.1 and later (`inventory.js:677-686`). */
interface WindowClick {
  readonly windowId: number;
  readonly stateId: number;
  readonly slot: number;
  readonly mouseButton: number;
  readonly mode: number;
  readonly changedSlots: readonly { readonly location: number; readonly item: Notch }[];
  readonly cursorItem: Notch;
}

interface ContainerRecord {
  slots: (Item | null)[];
}

interface OpenContainer {
  readonly window: ServerWindow;
  readonly key: string;
  readonly record: ContainerRecord;
}

type ItemApi = typeof Item & { fromNotch(notch: Notch): Item | null; toNotch(item: Item | null): Notch; equal(left: Item | null, right: Item | null, matchStackSize?: boolean): boolean };

/** What the server compares a client's claim with: the same variant and the same count, or both empty (the components count: measured where the count differs too, contract checks click-window-onto-variant and click-window-variant-split). */
function sameStack(claimed: Item | null, actual: Item | null): boolean {
  if (claimed === null || actual === null) return claimed === actual;
  return sameItemVariant(claimed, actual) && claimed.count === actual.count;
}

const keyOf = ({ x, y, z }: Vec3): string => `${x},${y},${z}`;

interface WindowServerParts {
  readonly server: FakeServer;
  readonly world: FakeWorld;
  readonly inventory: FakeInventory;
  readonly containers: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The server's spawn of an entity: where a stack in hand that fits nowhere falls at a close. */
  readonly spawn: ServerEntities["spawn"];
}

/** The server's windows of one bot: its player window, the container windows it opens, and the packets it answers with. */
class WindowServer implements FakeWindowServer {
  private readonly client: FakeBot["_client"];
  private readonly ItemClass: ItemApi;
  private readonly windowLibrary: WindowsExports;
  private readonly records = new Map<string, ContainerRecord>();
  private readonly stateIds = new Map<number, number>([[0, LOGIN_PLAYER_STATE_ID]]);
  private readonly stackMoves: QuickMoveItems & ClickItems;
  private player: ServerWindow | null = null;
  private open: OpenContainer | null = null;
  private lastWindowId = 0;
  private predicting = 0;
  private readonly clickListeners = new Set<(click: { readonly slot: number; readonly mouseButton: number; readonly mode: number }) => void>();

  constructor(
    private readonly bot: FakeBot,
    private readonly parts: WindowServerParts,
  ) {
    this.client = bot._client;
    this.ItemClass = (require("prismarine-item") as (registry: FakeBot["registry"]) => ItemApi)(bot.registry);
    this.windowLibrary = (require("prismarine-windows") as (registry: FakeBot["registry"]) => WindowsExports)(bot.registry);
    this.stackMoves = {
      withCount: (item, count) => itemWithCount(bot.registry, item, count),
      sameItem: sameItemVariant,
    };
    const { server } = parts;
    server.onPacket("block_place", (data) => {
      const { location } = data as { location: Vec3 };
      if (this.opensWindowAt(location)) server.answer(() => this.openContainer(location));
    });
    server.onPacket("window_click", (data) => {
      const click = data as WindowClick;
      server.answer(() => this.applyClick(click));
      for (const listener of [...this.clickListeners]) listener({ slot: click.slot, mouseButton: click.mouseButton, mode: click.mode });
    });
    server.onPacket("close_window", (data) => {
      const { windowId } = data as { windowId: number };
      server.answer(() => void (this.open?.window.id === windowId && this.closeOpen()));
    });
  }

  get openWindowId(): number | null {
    return this.open?.window.id ?? null;
  }

  predict<T>(prediction: () => T): T {
    this.playerWindow();
    this.predicting += 1;
    try {
      return prediction();
    } finally {
      this.predicting -= 1;
    }
  }

  containerStacks(cell: string): ContainerStack[] {
    const slots = this.open?.key === cell ? this.open.window.slots.slice(0, this.open.window.inventoryStart) : (this.recordOf(cell)?.slots ?? []);
    return slots.flatMap((item, slot) => (item === null ? [] : [{ slot, name: stackNameOf(this.bot.registry, item), count: item.count }]));
  }

  setContainerStacks(cell: string, stacks: readonly ContainerStack[]): void {
    const record = this.recordOf(cell);
    if (record === undefined) throw new Error(`no container block at ${cell}`);
    const slots: (Item | null)[] = record.slots.map(() => null);
    for (const { slot, name, count } of stacks) slots[slot] = itemOf(this.bot.registry, name, count);
    if (this.open?.key !== cell) {
      record.slots = slots;
      return;
    }
    const { window } = this.open;
    slots.forEach((item, slot) => {
      if (sameStack(window.slots[slot] ?? null, item)) return;
      window.updateSlot(slot, item);
      this.sendSlot(window, slot);
    });
  }

  onClickReceived(listener: (click: { readonly slot: number; readonly mouseButton: number; readonly mode: number }) => void): () => void {
    this.clickListeners.add(listener);
    return () => void this.clickListeners.delete(listener);
  }

  closeOpenWindow(): void {
    if (this.open === null) return;
    this.client.emit("close_window", { windowId: this.open.window.id });
    this.closeOpen();
  }

  opensWindowAt(location: Vec3): boolean {
    return this.menuAt(location) !== undefined;
  }

  private copy(item: Item | null): Item | null {
    return item === null ? null : this.ItemClass.fromNotch(this.ItemClass.toNotch(item));
  }

  private createWindow(id: number, menu: string, title: unknown): ServerWindow {
    const window = this.windowLibrary.createWindow(id, menu, title as string) as unknown as ServerWindow;
    installVariantClicks(window, this.stackMoves);
    return window;
  }

  private nextStateId(windowId: number): number {
    const next = ((this.stateIds.get(windowId) ?? -1) + 1) & 0x7fff;
    this.stateIds.set(windowId, next);
    return next;
  }

  /** The server's record of the player window: the client's inventory when the windows started, then every change a test or the game makes outside a click. */
  private playerWindow(): ServerWindow {
    if (this.player !== null) return this.player;
    const player = (this.player = this.createWindow(0, "minecraft:inventory", "Inventory"));
    this.parts.inventory.slots.forEach((item, slot) => player.updateSlot(slot, this.copy(item)));
    this.parts.inventory.on("updateSlot", (slot: number, _before: Item | null, after: Item | null) => {
      if (this.predicting > 0) return;
      player.updateSlot(slot, this.copy(after));
    });
    return player;
  }

  private menuAt(location: Vec3): string | undefined {
    return MENU_OF_BLOCK[this.parts.world.blockAt(location)?.name ?? ""];
  }

  private recordAt(key: string, menu: string): ContainerRecord {
    const known = this.records.get(key);
    if (known !== undefined) return known;
    const slots: (Item | null)[] = new Array(this.createWindow(0, menu, "").slots.length - PLAYER_SLOT_COUNT).fill(null);
    stacksOf(this.bot.registry, this.parts.containers[key] ?? {}).forEach(({ name, count }, slot) => (slots[slot] = itemOf(this.bot.registry, name, count)));
    const record = { slots };
    this.records.set(key, record);
    return record;
  }

  /** The server's record of the container block at `cell` ("x,y,z"), made from the harness's stacks the first time it is needed. */
  private recordOf(cell: string): ContainerRecord | undefined {
    const [x, y, z] = cell.split(",").map(Number);
    const menu = this.menuAt(new Vec3(x!, y!, z!));
    return menu === undefined ? undefined : this.recordAt(cell, menu);
  }

  /** `Player.canInteractWithBlock(pos, 1.0)`: the eye inside the block's box grown by the reach, and within 8 blocks of its centre. */
  private inReach(location: Vec3): boolean {
    const eye = this.bot.entity.position.offset(0, EYE_HEIGHT, 0);
    const axes: [number, number][] = [[eye.x, location.x], [eye.y, location.y], [eye.z, location.z]];
    const withinBox = axes.every(([at, cell]) => at >= cell - REACH && at <= cell + 1 + REACH);
    return withinBox && eye.distanceTo(location.offset(0.5, 0.5, 0.5)) < MAX_CENTRE_DISTANCE;
  }

  private sendItems(window: ServerWindow): void {
    this.client.emit("window_items", {
      windowId: window.id,
      stateId: this.nextStateId(window.id),
      items: window.slots.map((item) => this.ItemClass.toNotch(item)),
      carriedItem: this.ItemClass.toNotch(window.selectedItem),
    });
  }

  private sendSlot(window: ServerWindow, slot: number): void {
    this.client.emit("set_slot", { windowId: window.id, stateId: this.nextStateId(window.id), slot, item: this.ItemClass.toNotch(window.slots[slot] ?? null) });
  }

  /** Hand the container's slots back to the record and the player's to the player window, as a close does. */
  private closeOpen(): void {
    if (this.open === null) return;
    const { window, record } = this.open;
    record.slots = window.slots.slice(0, window.inventoryStart).map((item) => this.copy(item));
    for (let index = 0; index < PLAYER_SLOT_COUNT; index += 1) this.playerWindow().updateSlot(PLAYER_MAIN_START + index, this.copy(window.slots[window.inventoryStart + index] ?? null));
    this.open = null;
    if (window.selectedItem !== null) this.giveBack(window.selectedItem);
  }

  /**
   * The stack a closed window held in hand goes back to the inventory (`AbstractContainerMenu.removed`): onto a partial
   * stack of its variant, then into a free slot, each answered with `set_slot` of the player window; what fits nowhere falls to
   * the ground as an item entity. Measured by contract check `variant-transfer-clicks`: one free slot takes it (`set_slot` of that slot) and a full
   * inventory drops it, renamed as it was; the slot order (hotbar first, partial stacks before free slots) is the game's `Inventory.add`, unmeasured.
   */
  private giveBack(held: Item): void {
    const player = this.playerWindow();
    let left = held.count;
    const put = (slot: number, count: number) => {
      player.updateSlot(slot, itemWithCount(this.bot.registry, held, count));
      this.sendSlot(player, slot);
    };
    for (const slot of GIVE_BACK_ORDER) {
      const there = player.slots[slot];
      if (left === 0 || there === null || there === undefined || !sameItemVariant(there, held) || there.count >= there.stackSize) continue;
      const total = Math.min(there.stackSize, there.count + left);
      left -= total - there.count;
      put(slot, total);
    }
    for (const slot of GIVE_BACK_ORDER) {
      if (left === 0 || player.slots[slot] !== null) continue;
      const total = Math.min(held.stackSize, left);
      left -= total;
      put(slot, total);
    }
    if (left > 0) {
      const { x, y, z } = this.bot.entity.position;
      this.parts.spawn({ name: "item", position: new Vec3(x, y + DROP_HEIGHT, z), item: { name: stackNameOf(this.bot.registry, held), count: left }, pickupDelayTicks: DROP_PICKUP_DELAY_TICKS });
    }
  }

  /** A block used: `open_window`, then the window's items (the order the check `chest-open-take-close` measured). */
  private openContainer(location: Vec3): void {
    const menu = this.menuAt(location);
    if (menu === undefined || !this.inReach(location)) return;
    this.closeOpen();
    const key = keyOf(location);
    const record = this.recordAt(key, menu);
    this.lastWindowId = (this.lastWindowId % LAST_WINDOW_ID) + 1;
    // The server names a container by translation key, as anonymous NBT (measured for a chest: `container.chest`; other blocks follow the same pattern, unmeasured).
    const title = { type: "compound", value: { translate: { type: "string", value: `container.${this.parts.world.blockAt(location)!.name}` } } };
    const window = this.createWindow(this.lastWindowId, menu, title);
    record.slots.forEach((item, slot) => window.updateSlot(slot, this.copy(item)));
    for (let index = 0; index < PLAYER_SLOT_COUNT; index += 1) window.updateSlot(window.inventoryStart + index, this.copy(this.playerWindow().slots[PLAYER_MAIN_START + index] ?? null));
    this.open = { window, key, record };
    this.stateIds.set(window.id, 0);
    this.client.emit("open_window", { windowId: window.id, inventoryType: this.windowLibrary.windows[menu]!.type, windowTitle: title });
    this.sendItems(window);
  }

  /** The window a click is for: the open container's, or the player's when none is open; none for any other id. */
  private windowOfClick(windowId: number): ServerWindow | null {
    if (windowId === 0 && this.open === null) return this.playerWindow();
    return this.open?.window.id === windowId ? this.open.window : null;
  }

  /** The click applied to the server's window, then what the client got wrong sent back (`ServerGamePacketListenerImpl.handleContainerClick`). */
  private applyClick(click: WindowClick): void {
    const window = this.windowOfClick(click.windowId);
    if (window === null) return;
    const stale = click.stateId !== (this.stateIds.get(window.id) ?? -1);
    const claimed = window.slots.map((item) => this.copy(item));
    try {
      if (click.mode === SHIFT_CLICK) quickMove(window, click.slot, this.stackMoves);
      else window.acceptClick({ slot: click.slot, mouseButton: click.mouseButton, mode: click.mode, windowId: window.id, item: window.slots[click.slot] ?? null });
    } catch {
      return; // a click the library rejects as invalid changes nothing
    }
    if (stale) return this.sendItems(window);
    for (const { location, item } of click.changedSlots) claimed[location] = this.ItemClass.fromNotch(item);
    window.slots.forEach((item, slot) => {
      if (!sameStack(claimed[slot] ?? null, item)) this.sendSlot(window, slot);
    });
    if (!sameStack(this.ItemClass.fromNotch(click.cursorItem), window.selectedItem)) this.client.emit("set_cursor_item", { contents: this.ItemClass.toNotch(window.selectedItem) });
  }
}

export function createWindowServer(bot: FakeBot, parts: WindowServerParts): FakeWindowServer {
  return new WindowServer(bot, parts);
}
