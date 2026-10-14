import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { craftingBot } from "../test-support/crafting.js";
import type { WorldBlock } from "../world/placement.js";
import type { ActionResult } from "./action.js";
import { useTemporaryWorkstation, type WorkstationOperations } from "./temporary-workstation.js";

function fixture() {
  const { bot } = craftingBot({ crafting_table: 1 });
  const position = new Vec3(1, 64, 0);
  const block = { name: "crafting_table", position } as WorldBlock;
  const calls: string[] = [];
  bot.blockAt = () => block;
  const operations: WorkstationOperations = {
    place: async () => {
      calls.push("place");
      return { kind: "placed", block, position };
    },
    moveToOpenGround: async () => {
      calls.push("move");
      return true;
    },
    collect: async (_name, target) => {
      assert.deepEqual(target, position);
      calls.push("collect");
      bot.blockAt = () => ({ name: "air", position }) as WorldBlock;
      return { status: "succeeded" };
    },
  };
  const failure = (error: string): ActionResult => ({ status: "failed", error });
  return { bot, block, position, calls, operations, failure };
}

test("temporary station cleanup runs after success and an operation failure", async () => {
  for (const status of ["succeeded", "failed"] as const) {
    const f = fixture();
    const result = await useTemporaryWorkstation(
      f.bot,
      "crafting_table",
      {},
      f.operations,
      async () => {
        f.calls.push("craft batch");
        return status === "succeeded" ? { status } : { status, error: "craft failed" };
      },
      f.failure,
    );
    assert.equal(result.status, status);
    assert.equal(result.workstation?.recovered, true);
    assert.deepEqual(f.calls, ["place", "craft batch", "collect"]);
  }
});

test("missing carried workstation refuses before placement or crafting", async () => {
  const f = fixture();
  f.bot.inventory.items = () => [];
  const result = await useTemporaryWorkstation(
    f.bot,
    "crafting_table",
    {},
    f.operations,
    async () => {
      throw new Error("must not execute");
    },
    f.failure,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /WORKSTATION_NOT_CARRIED/);
  assert.deepEqual(f.calls, []);
});

test("a full inventory refuses before placement: the workstation could not be picked back up", async () => {
  const f = fixture();
  (f.bot.inventory as { emptySlotCount?: () => number }).emptySlotCount = () => 0;
  const result = await useTemporaryWorkstation(
    f.bot,
    "crafting_table",
    {},
    f.operations,
    async () => {
      throw new Error("must not execute");
    },
    f.failure,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /WORKSTATION_NO_ROOM/);
  assert.deepEqual(f.calls, []);
});

test("no_cell walks to open ground and places again once", async () => {
  const f = fixture();
  let tries = 0;
  f.operations.place = async () => {
    f.calls.push("place");
    tries += 1;
    return tries === 1 ? { kind: "no_cell" } : { kind: "placed", block: f.block, position: f.position };
  };
  const result = await useTemporaryWorkstation(
    f.bot,
    "crafting_table",
    {},
    f.operations,
    async () => {
      f.calls.push("craft batch");
      return { status: "succeeded" };
    },
    f.failure,
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.workstation?.recovered, true);
  assert.deepEqual(f.calls, ["place", "move", "place", "craft batch", "collect"]);
});

test("no_cell after the walk fails with the whole story and does not walk again", async () => {
  const f = fixture();
  f.operations.place = async () => {
    f.calls.push("place");
    return { kind: "no_cell" };
  };
  const result = await useTemporaryWorkstation(
    f.bot,
    "crafting_table",
    {},
    f.operations,
    async () => {
      throw new Error("must not execute");
    },
    f.failure,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /WORKSTATION_PLACEMENT_FAILED.*no_cell \(no dry, clear cell within 8 blocks: in water, a tunnel or a crowded spot\); move to open dry ground first/u);
  assert.deepEqual(f.calls, ["place", "move", "place"]);
});

test("no_cell with no standing spot found fails without a second placement", async () => {
  const f = fixture();
  f.operations.place = async () => {
    f.calls.push("place");
    return { kind: "no_cell" };
  };
  f.operations.moveToOpenGround = async () => {
    f.calls.push("move");
    return false;
  };
  const result = await useTemporaryWorkstation(
    f.bot,
    "crafting_table",
    {},
    f.operations,
    async () => {
      throw new Error("must not execute");
    },
    f.failure,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /no_cell/u);
  assert.deepEqual(f.calls, ["place", "move"]);
});

test("unconfirmed placement cannot start crafting and recovers an observed placed block", async () => {
  const f = fixture();
  f.operations.place = async () => ({ kind: "failed", position: f.position, error: "slot update missing" });
  const result = await useTemporaryWorkstation(
    f.bot,
    "crafting_table",
    {},
    f.operations,
    async () => {
      throw new Error("must not execute");
    },
    f.failure,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /WORKSTATION_PLACEMENT_FAILED/);
  assert.equal(result.workstation?.recovered, true);
  assert.deepEqual(f.calls, ["collect"]);
});

/**
 * A placed workstation that is not observed gone is never reported recovered,
 * and a recovery problem never overwrites the operation's own error.
 */
const unrecoveredRows = [
  {
    name: "collect refuses while the batch succeeded",
    collectFails: true,
    operationFailed: false,
    status: "partial",
    error: [/WORKSTATION_NOT_RECOVERED.*inventory full/],
  },
  {
    name: "collect refuses after the batch failed",
    collectFails: true,
    operationFailed: true,
    status: "failed",
    error: [/WORKSTATION_NOT_RECOVERED.*inventory full/, /craft failed/],
  },
  {
    // A matching item may be picked up from the ground; the block is still there.
    name: "collect claims success but the block remains",
    collectFails: false,
    operationFailed: false,
    status: "partial",
    error: [/Removal of the placed workstation was not observed/],
  },
] as const;

test("a workstation not observed gone is never reported recovered", async () => {
  for (const row of unrecoveredRows) {
    const f = fixture();
    f.operations.collect = async () =>
      row.collectFails ? { status: "failed", error: "inventory full" } : { status: "succeeded" };
    const result = await useTemporaryWorkstation(
      f.bot,
      "crafting_table",
      {},
      f.operations,
      async () => (row.operationFailed ? f.failure("craft failed") : { status: "succeeded" }),
      f.failure,
    );
    assert.equal(result.status, row.status, row.name);
    for (const pattern of row.error) assert.match(result.error ?? "", pattern, row.name);
    assert.equal(result.workstation?.recovered, false, row.name);
  }
});

test("cancellation releases ownership without moving to collect a workstation", async () => {
  const f = fixture();
  const controller = new AbortController();
  await assert.rejects(
    useTemporaryWorkstation(
      f.bot,
      "crafting_table",
      { signal: controller.signal },
      f.operations,
      async () => {
        controller.abort(new Error("cancelled"));
        controller.signal.throwIfAborted();
        return { status: "succeeded" };
      },
      f.failure,
    ),
    /cancelled/,
  );
  assert.deepEqual(f.calls, ["place"]);
});
