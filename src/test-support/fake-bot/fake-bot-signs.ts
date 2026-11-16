/** The measured sign editor and edit answers on the fake server. */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { blockFamilyMembers } from "../../world/item-families.js";
import type { FakeBot } from "./fake-bot.js";
import { sendBlockChange } from "./fake-bot-placement.js";
import type { FakeServer } from "./fake-server.js";
import type { FakeWorld } from "./fake-world.js";

const require = createRequire(import.meta.url);
const BLANK = "\n\n\n";

export interface FakeSignsOptions {
  /** Suppress the editor answer, for an unanswered-editor test. */
  readonly withheld?: boolean;
}

export interface FakeSigns {
  isSign(cell: Vec3): boolean;
  open(cell: Vec3): void;
  sendText(cell: Vec3): void;
}

/** Install Mineflayer's sign handlers on a scratch bot with the same client and world. */
function installSignPlugin(bot: FakeBot): void {
  const client = Object.assign(new EventEmitter(), { write: (name: string, data: unknown) => bot._client.write(name, data) });
  const scratch = Object.assign(new EventEmitter(), { registry: bot.registry, _client: client, world: bot.world, game: bot.game, entity: bot.entity, supportFeature: bot.supportFeature });
  (require("mineflayer/lib/plugins/blocks.js") as (bot: object, options: object) => void)(scratch, { version: bot.version, hideErrors: true });
  const signs = scratch as typeof scratch & Pick<Bot, "blockAt" | "updateSign">;
  signs.blockAt = (cell) => bot.blockAt(cell);
  scratch.on("signOpen", (block) => bot.emit("signOpen", block));
  scratch.on("blockEntityData", (block) => bot.emit("blockEntityData", block));
  scratch.on("error", (error) => bot.emit("error", error));
  for (const name of ["open_sign_entity", "tile_entity_data"]) (bot._client as EventEmitter).on(name, (packet) => client.emit(name, packet));
  bot.updateSign = signs.updateSign;
}

/** Attach the editor state and accept the one edit authorized by its open packet. */
export function attachFakeSigns(bot: FakeBot, server: FakeServer, world: FakeWorld, options: FakeSignsOptions = {}): FakeSigns {
  installSignPlugin(bot);
  let editor: Vec3 | null = null;
  const isSign = (cell: Vec3) => {
    const block = world.blockAt(cell);
    return block !== null && blockFamilyMembers(bot, "sign").includes(block.name);
  };
  const sendText = (cell: Vec3) => {
    const block = world.blockAt(cell)!;
    if (!block.entity) block.setSignText(BLANK, BLANK);
    bot._client.emit("tile_entity_data", { location: cell, nbtData: block.entity });
  };
  server.onPacket("update_sign", (data) => {
    const edit = data as { location: Vec3; isFrontText: boolean; text1: string; text2: string; text3: string; text4: string };
    server.answer(() => {
      if (!editor?.equals(edit.location) || !edit.isFrontText || !isSign(edit.location)) return;
      editor = null;
      const block = world.blockAt(edit.location)!;
      const back = block.entity ? block.getSignText()[1] : BLANK;
      block.setSignText([edit.text1, edit.text2, edit.text3, edit.text4].join("\n"), back);
      sendBlockChange(bot, world, edit.location, true);
      bot._client.emit("tile_entity_data", { location: edit.location, nbtData: block.entity });
    });
  });
  return {
    isSign,
    open(cell) {
      if (options.withheld) return;
      editor = cell.clone();
      bot._client.emit("open_sign_entity", { location: cell, isFrontText: true });
    },
    sendText,
  };
}
