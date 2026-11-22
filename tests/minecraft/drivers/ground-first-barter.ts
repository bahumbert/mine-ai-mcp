import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { barterResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import type { Bot } from "mineflayer";
import { z } from "zod";
import { arenaActionInput } from "../arena/frame.ts";
import type { ScenarioContext } from "../scenario.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { droppedItemName, isItemEntity } from "../../../src/world/item-pickup.ts";
import { observeMobAge } from "../../../src/world/mob-age.ts";
import { DEFAULT_POLL_MS, SERVER_ANSWER_TICKS, serverPacedWallMs, serverTickDeadline } from "../../../src/world/world-age.ts";

/** The piglin and the pearl are on the client, both read as `barter` reads them (adult age, the stack name of the item entity). */
function piglinSeen(bot: Bot): boolean {
  return Object.values(bot.entities).some((entity) => entity.name === "piglin" && observeMobAge(bot, entity) === "adult");
}

function pearlReadable(bot: Bot, itemName: string): boolean {
  return Object.values(bot.entities).some((entity) => isItemEntity(entity) && droppedItemName(entity) === itemName);
}

/**
 * Waits until the client can read the fixture's pearl and piglin before `barter` decides on the ground: Mine Labs summons
 * the YAML entities after the clients are prepared, so the pearl can reach the client after the driver starts (plan
 * 2026-11-17-p1-barter-a1 C2). Looks on each entity packet and every `DEFAULT_POLL_MS`; the bound is `SERVER_ANSWER_TICKS` of
 * server time, with a real-time backstop for a stopped server.
 */
async function waitForFixturePearl(bot: Bot, itemName: string, sleep: (ms: number) => Promise<void>): Promise<{ readable: true } | { readable: false; piglinSeen: boolean }> {
  let readable = false;
  const look = () => {
    readable ||= piglinSeen(bot) && pearlReadable(bot, itemName);
  };
  const deadline = serverTickDeadline(() => bot.time?.age, SERVER_ANSWER_TICKS, monotonicNow(), { origin: "packet", wallMs: serverPacedWallMs(SERVER_ANSWER_TICKS) });
  bot.on("entitySpawn", look);
  bot.on("entityUpdate", look);
  bot.on("itemDrop", look);
  try {
    for (;;) {
      look();
      if (readable) return { readable: true };
      if (deadline.passed(monotonicNow())) return { readable: false, piglinSeen: piglinSeen(bot) };
      await sleep(DEFAULT_POLL_MS);
    }
  } finally {
    bot.off("entitySpawn", look);
    bot.off("entityUpdate", look);
    bot.off("itemDrop", look);
  }
}

/** An existing reward must be collected without spending gold or offering it to a piglin. */
export async function run(context: ScenarioContext, sleep: (ms: number) => Promise<void> = delay): Promise<ClientCompletion> {
  const { item_name: itemName } = z.object({ item_name: z.string() }).parse(context.scenario.params);
  const ready = await waitForFixturePearl(context.bot, itemName, sleep);
  if (!ready.readable) {
    return { status: "failed", detail: `[FIXTURE] the fixture's ${itemName} was not readable within ${SERVER_ANSWER_TICKS} server ticks of the start (piglin seen: ${ready.piglinSeen ? "yes" : "no"})` };
  }
  const before = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  assert.equal(before.status, "succeeded");
  const piglin = before.situation.nearby.mobs.find((mob) => mob.name === "piglin" && mob.age === "adult");
  assert.ok(piglin, "The fixture must offer a real, loaded adult piglin to barter with.");
  assert.ok(before.situation.nearby.droppedItems.some((item) => item.name === itemName), "The fixture must show the ground pearl before barter.");
  const output = await context.call("barter", { ...arenaActionInput(context.scenario.params, context.arena), piglin_id: piglin.nearest.entityId });
  const result = barterResultSchema.parse(output.result);
  const after = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  assert.equal(after.status, "succeeded");
  const goldCount = (stacks: typeof before.situation.inventory.stacks) => stacks
    .filter((item) => item.name === "gold_ingot" && (item.location === "main" || item.location === "hotbar"))
    .reduce((sum, item) => sum + item.count, 0);
  const actualGoldSpent = goldCount(before.situation.inventory.stacks) - goldCount(after.situation.inventory.stacks);
  assert.equal(result.status, "succeeded", output.summary);
  assert.deepEqual(result.barter.dropsTakenByOthers, []);
  assert.equal(actualGoldSpent, 0);
  assert.equal(result.barter.goldSpent, actualGoldSpent);
  assert.equal(result.barter.goldOffers, 0);
  return { status: "succeeded", detail: `Observed ${actualGoldSpent} gold spent; ${output.summary}` };
}
