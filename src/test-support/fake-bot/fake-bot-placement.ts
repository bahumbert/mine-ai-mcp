/**
 * The fake bot's block placement. `_genericPlace` is Mineflayer's own `generic_place.js` (the look at the face, the swing,
 * the click with its cursor inside the face, the sequence), installed on the bot; `_placeBlockWithOptions` and
 * `placeBlock` mirror `place_block.js` line for line, but for its timer, which is the fake clock's (the library's is the
 * global `setTimeout`, which a manual clock does not move). The server's answer is as the 1.21.4 server gave it (contract
 * check `place-block-with-options`, Mine Labs 2026-10-23): the clicked block, the placed block twice, the slot, then the
 * acknowledgement of the click's sequence; a slab or a stair on a side face takes the half the click was in, on the top
 * face the bottom half; a taken destination is only acknowledged (Mineflayer's own wait then runs out).
 * A bed is put whole: its foot at the destination and its head one block on, the way she looks (`facing`), and the server
 * resends the destination once (the chunk's own change carries both halves, as a `multi_block_change` the fake does not send).
 * Mineflayer emits a `blockUpdate` for every `block_change` packet, so the cell of a block put alone hears two, both to the
 * placed block, within one tick (contract check `placement-block-update`, Mine Labs 2026-10-24, 10 of 10 runs), and the
 * clicked block hears one, unchanged (`blocks.js` `updateBlockState`; the game was measured to send the packet).
 * Vanilla's rules, not measured: a creative bot keeps its stack, a stair's facing and shape, a slab onto a slab, a bed's head
 * needing an empty cell (nothing is put otherwise), the server's yaw being the client's at the moment it answers.
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { type MineflayerBlock, blockClass } from "../../navigation/mineflayer/world.js";
import type { FakeBot } from "./fake-bot.js";
import { FACE_VECTORS } from "./fake-bot-look.js";
import type { FakeClock } from "./fake-clock.js";
import { EQUIPMENT_SLOTS, type FakeInventory, itemOf } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";
import type { FakeWindows } from "./fake-window-server.js";
import { type FakeCell, type FakeWorld, blockUpdateEventOf } from "./fake-world.js";

const require = createRequire(import.meta.url);

/** Mineflayer's wait for a placement's block update, counted from the packet (`place_block.js`). */
const PLACEMENT_TIMEOUT_MS = 5_000;
/** `block_place`'s hand: 0 the main hand, 1 the off hand. */
const OFF_HAND = 1;
/** `arm_animation`'s hand for each arm (`entities.js` `swingArm`). */
const ARM_HANDS = { right: 0, left: 1 } as const;
/** A click above this share of a face's height is in its upper half. */
const UPPER_HALF = 0.5;

/** What `place_block.js` takes: the half a stair or slab is clicked in, the exact cursor, whether to turn the head, the hand and the arm. */
export interface PlacementOptions {
  readonly half?: "top" | "bottom";
  readonly delta?: Vec3;
  readonly forceLook?: boolean | "ignore";
  readonly offhand?: boolean;
  readonly swingArm?: "right" | "left";
  readonly showHand?: boolean;
}
export type PlaceBlockWithOptions = (referenceBlock: MineflayerBlock, faceVector: Vec3, options: PlacementOptions) => Promise<void>;

type GenericPlace = (referenceBlock: MineflayerBlock, faceVector: Vec3, options: PlacementOptions & { onSent?: (sequence: number | undefined) => void }) => Promise<void>;
type PlacingBot = FakeBot & { _genericPlace: GenericPlace };

/** What the client wrote to place a block (`generic_place.js`, the 1.21.4 packet). */
interface BlockPlaceClick {
  readonly location: Vec3;
  readonly direction: number;
  readonly hand: number;
  readonly cursorY: number;
  readonly sequence?: number;
}

type Outcome =
  | { readonly kind: "changed"; readonly before: MineflayerBlock | null; readonly after: MineflayerBlock | null }
  | { readonly kind: "unchanged"; readonly name: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "ended" };

type PlacementParts = { clock: FakeClock; server: FakeServer; world: FakeWorld; inventory: FakeInventory; windows: FakeWindows };

/** What `place_block.js` listens to while a placement runs, and what it learns from it. */
interface PlacementWatch {
  /** The destination as it was when the click was sent. */
  oldBlock(): MineflayerBlock | null;
  /** The click went out with this sequence; the connection ending before it throws. */
  sent(sequence: number | undefined): void;
  stop(): void;
}

/** The listeners of `place_block.js`: the destination's update, the server's correction with its acknowledgement, the end of the connection. */
function watchPlacement(bot: PlacingBot, destination: Vec3, finish: (outcome: Outcome) => void, endPlacement: () => void): PlacementWatch {
  const client = bot._client;
  const eventName = blockUpdateEventOf(destination);
  let oldBlock = bot.blockAt(destination);
  let isSent = false;
  let sequence: number | undefined;
  let correctedState: number | undefined;
  let acknowledged = false;
  let ended = false;

  const onBlockUpdate = (before: MineflayerBlock | null, after: MineflayerBlock | null) => {
    if (isSent && (!before || !after || before.type !== after.type)) finish({ kind: "changed", before, after });
  };
  const observeProcessed = () => {
    // An acknowledgement proves processing, not success. A post-send server correction must also show the original state still at the destination.
    if (acknowledged && correctedState !== undefined && correctedState === oldBlock?.stateId && bot.blockAt(destination)?.stateId === correctedState) {
      finish({ kind: "unchanged", name: bot.blockAt(destination)!.name });
    }
  };
  const onCorrection = (packet: { location: Vec3; type: number }) => {
    if (!isSent || !destination.equals(packet.location)) return;
    correctedState = packet.type;
    observeProcessed();
  };
  const onAcknowledgement = (packet: { sequenceId: number }) => {
    if (sequence === undefined || !Number.isInteger(packet.sequenceId) || packet.sequenceId < sequence) return;
    acknowledged = true;
    observeProcessed();
  };
  const onEnd = () => {
    ended = true;
    endPlacement();
    finish({ kind: "ended" });
  };

  bot.on(eventName, onBlockUpdate);
  client.on("end", onEnd);
  const sequenced = bot.registry.version[">="]("1.19");
  if (sequenced) {
    client.on("block_change", onCorrection);
    client.on("acknowledge_player_digging", onAcknowledgement);
  }
  return {
    oldBlock: () => oldBlock,
    sent(sentSequence) {
      if (ended) throw new Error("Connection ended while placing block");
      oldBlock = bot.blockAt(destination);
      sequence = sentSequence;
      isSent = true;
    },
    stop() {
      bot.removeListener(eventName, onBlockUpdate);
      client.removeListener("end", onEnd);
      client.removeListener("block_change", onCorrection);
      client.removeListener("acknowledge_player_digging", onAcknowledgement);
    },
  };
}

/** `place_block.js` `placeBlockWithOptions`: `_genericPlace`, then the cell's update, the server's correction with its acknowledgement, the end of the connection, or 5 s of nothing. */
async function placeBlockWithOptions(bot: PlacingBot, clock: FakeClock, referenceBlock: MineflayerBlock, faceVector: Vec3, options: PlacementOptions): Promise<void> {
  const destination = referenceBlock.position.plus(faceVector);
  let cancelTimeout = () => undefined as void;
  let endPlacement = () => undefined as void;
  let finish = (_outcome: Outcome) => undefined as void;
  const disconnected = new Promise<void>((resolve) => void (endPlacement = resolve));
  const observed = new Promise<Outcome>((resolve) => void (finish = resolve));
  const watch = watchPlacement(bot, destination, finish, endPlacement);
  try {
    await Promise.race([
      bot._genericPlace(referenceBlock, faceVector, { ...options, onSent: (sequence) => watch.sent(sequence) }),
      disconnected.then(() => {
        throw new Error("Connection ended while placing block");
      }),
    ]);
    const [oldBlock, current] = [watch.oldBlock(), bot.blockAt(destination)];
    if (oldBlock && current && oldBlock.type !== current.type) finish({ kind: "changed", before: oldBlock, after: current });
    // Preserve the existing timeout when the protocol or server supplies no conclusive correction/ack pair. It starts after the placement is sent.
    cancelTimeout = clock.after(PLACEMENT_TIMEOUT_MS, () => finish({ kind: "timeout" }));
    const result = await observed;
    if (result.kind === "unchanged") throw new Error(`Server processed placement, but block at ${destination} is still ${result.name}`);
    if (result.kind === "ended") throw new Error("Connection ended while placing block");
    if (result.kind === "timeout") throw new Error(`Event ${blockUpdateEventOf(destination)} did not fire within timeout of ${PLACEMENT_TIMEOUT_MS}ms`);
    const { before, after } = result;
    // `blockUpdate` emits (null, null) when the world unloads.
    if (!before && !after) return;
    if (before?.type === after?.type) throw new Error(`No block has been placed : the block is still ${before?.name}`);
    bot.emit("blockPlaced" as never, before as never, after as never);
  } finally {
    cancelTimeout();
    watch.stop();
  }
}

/** The half a stair or slab is in when clicked on `face` at `cursorY` of the face's height: the top face gives the bottom half, the bottom face the top half. */
function halfClicked(face: Vec3, cursorY: number): "top" | "bottom" {
  if (face.y !== 0) return face.y > 0 ? "bottom" : "top";
  return cursorY > UPPER_HALF ? "top" : "bottom";
}

/** A cell a placement fills, and the block it holds. */
interface PlacedCell {
  readonly cell: Vec3;
  readonly block: FakeCell;
}

/** The side a look faces, as the game's `getDirection` names it: the nearest of the four (Mineflayer's yaw 0 faces north, a quarter turn left is west). */
function facingOfYaw(yaw: number): { name: "north" | "south" | "west" | "east"; vector: Vec3 } {
  const x = -Math.sin(yaw);
  const z = -Math.cos(yaw);
  if (Math.abs(x) > Math.abs(z)) return x > 0 ? { name: "east", vector: new Vec3(1, 0, 0) } : { name: "west", vector: new Vec3(-1, 0, 0) };
  return z > 0 ? { name: "south", vector: new Vec3(0, 0, 1) } : { name: "north", vector: new Vec3(0, 0, -1) };
}

/** The block `name` with the states named set and every other state at the block's default (a state left out would read as the first of its values). */
function blockWith(bot: FakeBot, name: string, states: Record<string, string>): FakeCell {
  const defaults = blockClass(bot).fromStateId(bot.registry.blocksByName[name]!.defaultState!, 0).getProperties();
  return { name, properties: { ...defaults, ...states } };
}

/** The cells a held block item fills at `destination`: a slab or stair in the half the click was in, a bed whole, any other block in its default state. */
function placedCells(bot: FakeBot, name: string, destination: Vec3, face: Vec3, cursorY: number): PlacedCell[] {
  if (name.endsWith("_slab")) return [{ cell: destination, block: blockWith(bot, name, { type: halfClicked(face, cursorY) }) }];
  if (name.endsWith("_stairs")) return [{ cell: destination, block: blockWith(bot, name, { half: halfClicked(face, cursorY) }) }];
  if (name.endsWith("_bed")) {
    const facing = facingOfYaw(bot.entity.yaw);
    return [
      { cell: destination, block: blockWith(bot, name, { part: "foot", facing: facing.name }) },
      { cell: destination.plus(facing.vector), block: blockWith(bot, name, { part: "head", facing: facing.name }) },
    ];
  }
  return [{ cell: destination, block: name }];
}

/**
 * The server sends a block as the client's `block_change` packet; Mineflayer sets the state it carries and the world
 * emits a `blockUpdate` for it, changed or not. The update of the first packet that changes the cell is `setCell`'s own,
 * so only a packet that repeats the state the world already has (`repeats`) emits its update here.
 */
function sendBlockChange(bot: FakeBot, world: FakeWorld, cell: Vec3, repeats: boolean): void {
  // Mineflayer's own `block_change` listener (the world and its update) runs before `place_block.js`'s.
  if (repeats) world.resend(cell);
  bot._client.emit("block_change", { location: { x: cell.x, y: cell.y, z: cell.z }, type: world.getBlockStateId(cell) });
}

/** The server's side of a click on a block's face: the held block put in an empty destination, one taken from the stack outside creative, then the acknowledgement. */
function answerPlacement(bot: FakeBot, parts: PlacementParts, click: BlockPlaceClick, face: Vec3): void {
  const { world, inventory } = parts;
  const destination = click.location.plus(face);
  const held = click.hand === OFF_HAND ? (inventory.slots[EQUIPMENT_SLOTS["off-hand"]] ?? null) : inventory.heldItem;
  const block = held === null ? undefined : bot.registry.blocksByName[held.name];
  const acknowledge = () => void bot._client.emit("acknowledge_player_digging", { sequenceId: click.sequence });
  // 1.21.4 sends the cursor as a share of the face; older versions as sixteenths.
  const cursorY = bot.supportFeature("blockPlaceHasHandAndIntCursor") ? click.cursorY / 16 : click.cursorY;
  const placed = held === null || block === undefined ? [] : placedCells(bot, block.name, destination, face, cursorY);
  const free = placed.length > 0 && placed.every(({ cell }) => {
    const there = world.blockAt(cell);
    return there !== null && there.shapes.length === 0;
  });
  if (held === null || !free) return acknowledge();
  sendBlockChange(bot, world, click.location, true);
  for (const { cell, block: placedBlock } of placed) world.setCell(cell, placedBlock);
  // A block put alone is announced twice (the chunk's change and the click's resend), the cell hearing two `blockUpdate`s
  // within the tick (contract check `placement-block-update`, 10 of 10); a bed's halves go in one `multi_block_change`
  // (`setCell`'s updates stand for it), then the destination's `block_change` repeats the foot: the foot hears two, the head one.
  const bed = placed.length > 1;
  sendBlockChange(bot, world, destination, bed);
  if (!bed) sendBlockChange(bot, world, destination, true);
  if (bot.game.gameMode !== "creative") inventory.updateSlot(held.slot, held.count > 1 ? itemOf(bot.registry, held.name, held.count - 1) : (null as never));
  acknowledge();
}

/** Give `bot` `swingArm`, `placeBlock`, `_placeBlockWithOptions` and the server's answer to `block_place`. */
export function attachFakePlacement(bot: FakeBot, parts: PlacementParts): void {
  const placing = bot as PlacingBot;
  (require("mineflayer/lib/plugins/generic_place") as (bot: Bot) => void)(placing);
  // `entities.js` `swingArm`: the arm told to the server, the hand left out when it is not shown.
  bot.swingArm = (arm = "right", showHand = true) => bot._client.write("arm_animation", showHand ? { hand: ARM_HANDS[arm] } : {});
  bot._placeBlockWithOptions = (referenceBlock, faceVector, options) => placeBlockWithOptions(placing, parts.clock, referenceBlock, faceVector, options);
  // `place_block.js` `placeBlock` calls its own closure: a test that scripts `_placeBlockWithOptions` does not change `placeBlock`.
  bot.placeBlock = (referenceBlock, faceVector) => placeBlockWithOptions(placing, parts.clock, referenceBlock, faceVector, { swingArm: "right" });
  parts.server.onPacket("block_place", (data) => {
    const click = data as BlockPlaceClick;
    const face = FACE_VECTORS[click.direction];
    // A block the server uses takes the click and nothing is placed against it: a bed (fake-bot-sleep.ts answers it) or a container (it opens its window, `fake-window-server.ts`).
    const clicked = parts.world.blockAt(click.location);
    if (clicked !== null && bot.isABed(clicked as never)) return;
    if (face !== undefined && !parts.windows.opensWindowAt(click.location)) parts.server.answer(() => answerPlacement(bot, parts, click, face));
  });
}
