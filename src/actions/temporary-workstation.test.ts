import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { craftingBot } from "../test-support/crafting.js";
import { type FakeClock, createFakeClock } from "../test-support/fake-bot/index.js";
import { startOwnPlacement, type OwnPlacement } from "../world/own-placement.js";
import type { WorldBlock } from "../world/placement.js";
import type { ActionResult } from "./action.js";
import { useTemporaryWorkstation, type WorkstationOperations } from "./temporary-workstation.js";

/** `clock`: a mocked one the test installs, for a test whose waits for the server (world age, wall bound) run on it. */
function fixture(clock?: FakeClock) {
  const { bot, counts } = craftingBot({ crafting_table: 1 }, false, [], { clock });
  const position = new Vec3(1, 64, 0);
  const block = { name: "crafting_table", position } as WorldBlock;
  const calls: string[] = [];
  bot.blockAt = () => block;
  const operations: WorkstationOperations = {
    place: async (_name, _signal, onPlacementSent) => {
      calls.push("place");
      onPlacementSent?.([position]); // the real placement calls it right before the packet
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
  return { bot, block, position, calls, operations, failure, counts };
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

/** The table as the world shows it once placed: no longer carried, standing at the position. */
function placeTableForReal(f: ReturnType<typeof fixture>): void {
  f.operations.place = async (_name, _signal, onPlacementSent) => {
    f.calls.push("place");
    onPlacementSent?.([f.position]);
    f.counts.set(f.bot.registry.itemsByName.crafting_table!.id, 0);
    return { kind: "placed", block: f.block, position: f.position };
  };
}

function abortingAttempt(f: ReturnType<typeof fixture>, hold: OwnPlacement) {
  const controller = new AbortController();
  return assert.rejects(
    useTemporaryWorkstation(
      f.bot,
      "crafting_table",
      { signal: controller.signal },
      f.operations,
      async () => {
        controller.abort(new Error("reflex took the body"));
        controller.signal.throwIfAborted();
        return { status: "succeeded" };
      },
      f.failure,
      hold,
    ),
    /reflex took the body/,
  );
}

test("a workstation left placed by an aborted attempt is reused by the next, never a second one", async () => {
  // Run 15: a reflex ended every smelt; with a resume the table stands and nothing carried is left to place again.
  const f = fixture();
  placeTableForReal(f);
  const hold = startOwnPlacement();
  await abortingAttempt(f, hold);
  assert.deepEqual(hold.cells, [f.position]);

  const result = await useTemporaryWorkstation(
    f.bot,
    "crafting_table",
    {},
    f.operations,
    async (block) => {
      f.calls.push("craft batch");
      assert.equal(block, f.block);
      return { status: "succeeded" };
    },
    f.failure,
    hold,
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.workstation?.recovered, true);
  assert.deepEqual(f.calls, ["place", "craft batch", "collect"]);
  assert.deepEqual(hold.cells, [], "recovered: the next call places afresh");
});

/**
 * The next attempt with the crafting table, run on `clock` until the server answered for the cell the last attempt
 * sent to: its answer counts once the clock moved the world age 40 ticks (2 s) past the send.
 */
function nextAttemptOnceTheServerAnswered(
  clock: FakeClock,
  f: ReturnType<typeof fixture>,
  hold: OwnPlacement,
  execute: (block: WorldBlock) => Promise<ActionResult> = async () => ({ status: "succeeded" }),
) {
  return clock.settle(useTemporaryWorkstation(f.bot, "crafting_table", {}, f.operations, execute, f.failure, hold), 2_000);
}

test("a workstation broken between attempts is placed again when it is carried again", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = fixture(clock);
  placeTableForReal(f);
  const hold = startOwnPlacement();
  await abortingAttempt(f, hold);
  f.bot.blockAt = () => ({ name: "air", position: f.position }) as WorldBlock;
  f.counts.set(f.bot.registry.itemsByName.crafting_table!.id, 1);
  f.operations.place = async () => {
    f.calls.push("place again");
    f.bot.blockAt = () => f.block;
    return { kind: "placed", block: f.block, position: f.position };
  };
  // "The server answered": "gone" is its answer.
  const result = await nextAttemptOnceTheServerAnswered(clock, f, hold);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(f.calls, ["place", "place again", "collect"]);
});

test("a workstation broken between attempts and not carried is the usual refusal", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = fixture(clock);
  placeTableForReal(f);
  const hold = startOwnPlacement();
  await abortingAttempt(f, hold);
  f.bot.blockAt = () => ({ name: "air", position: f.position }) as WorldBlock;
  // "The server answered": "gone" is its answer.
  const result = await nextAttemptOnceTheServerAnswered(clock, f, hold, async () => { throw new Error("must not execute"); });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /WORKSTATION_NOT_CARRIED/);
  assert.deepEqual(hold.cells, []);
});

test("an abort during the recovery keeps the workstation for one more attempt that collects it once", async () => {
  const f = fixture();
  placeTableForReal(f);
  const hold = startOwnPlacement();
  const controller = new AbortController();
  const collect = f.operations.collect;
  f.operations.collect = async () => {
    f.calls.push("collect aborted");
    controller.abort(new Error("reflex during recovery"));
    throw controller.signal.reason;
  };
  await assert.rejects(
    useTemporaryWorkstation(
      f.bot, "crafting_table", { signal: controller.signal }, f.operations, async () => ({ status: "succeeded" }), f.failure, hold,
    ),
    /reflex during recovery/,
  );
  f.operations.collect = collect;
  const result = await useTemporaryWorkstation(
    f.bot, "crafting_table", {}, f.operations, async () => ({ status: "succeeded" }), f.failure, hold,
  );
  assert.equal(result.workstation?.recovered, true);
  assert.deepEqual(f.calls, ["place", "collect aborted", "collect"]);
});

test("a held workstation whose chunk is not loaded is not replaced by a second one", async () => {
  const f = fixture();
  placeTableForReal(f);
  const hold = startOwnPlacement();
  await abortingAttempt(f, hold);
  f.bot.blockAt = () => null;
  const result = await useTemporaryWorkstation(
    f.bot, "crafting_table", {}, f.operations, async () => { throw new Error("must not execute"); }, f.failure, hold,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /WORKSTATION_NOT_LOADED/);
  assert.deepEqual(hold.cells, [f.position], "still ours: a later attempt can find it");
  assert.deepEqual(f.calls, ["place"]);
});

/** A placement the abort cuts off: the cell was chosen, and the block lands (or not) before the abort is thrown. */
function cutOffPlacement(f: ReturnType<typeof fixture>, controller: AbortController, blockLands: boolean) {
  f.operations.place = async (_name, _signal, onPlacementSent) => {
    f.calls.push("place");
    onPlacementSent?.([f.position]);
    if (blockLands) f.counts.set(f.bot.registry.itemsByName.crafting_table!.id, 0);
    else f.bot.blockAt = () => ({ name: "air", position: f.position }) as WorldBlock;
    controller.abort(new Error("reflex during the placement"));
    throw controller.signal.reason;
  };
}

test("an abort after the block landed but before the placement answered: the next attempt reuses it, no second block", async () => {
  // placeBlock waits for the server's block update; a reflex can abort in that wait with the block already set.
  const f = fixture();
  const controller = new AbortController();
  const hold = startOwnPlacement();
  cutOffPlacement(f, controller, true);
  await assert.rejects(
    useTemporaryWorkstation(f.bot, "crafting_table", { signal: controller.signal }, f.operations, async () => ({ status: "succeeded" }), f.failure, hold),
    /reflex during the placement/,
  );
  assert.deepEqual(hold.cells, [f.position], "the cell was recorded at the send, before the place call could throw");

  const result = await useTemporaryWorkstation(
    f.bot, "crafting_table", {}, f.operations, async (block) => {
      f.calls.push("craft batch");
      assert.equal(block, f.block);
      return { status: "succeeded" };
    }, f.failure, hold,
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.workstation?.recovered, true);
  assert.deepEqual(f.calls, ["place", "craft batch", "collect"]);
});

test("an abort before the block landed: the next attempt finds the cell empty and places normally", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = fixture(clock);
  const controller = new AbortController();
  const hold = startOwnPlacement();
  cutOffPlacement(f, controller, false);
  await assert.rejects(
    useTemporaryWorkstation(f.bot, "crafting_table", { signal: controller.signal }, f.operations, async () => ({ status: "succeeded" }), f.failure, hold),
    /reflex during the placement/,
  );
  f.operations.place = async (_name, _signal, onPlacementSent) => {
    f.calls.push("place again");
    onPlacementSent?.([f.position]);
    f.bot.blockAt = () => f.block;
    return { kind: "placed", block: f.block, position: f.position };
  };
  // "The server answered": the empty cell is its answer.
  const result = await nextAttemptOnceTheServerAnswered(clock, f, hold);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(f.calls, ["place", "place again", "collect"]);
});

test("a workstation a reflex set down in the chosen cell before the send is not ours", async () => {
  // Nothing was sent, so no server answer is awaited: no clock to drive.
  const f = fixture();
  const controller = new AbortController();
  const hold = startOwnPlacement();
  // Cut during the equip: the cell was chosen, nothing was sent.
  f.operations.place = async () => {
    f.calls.push("place");
    controller.abort(new Error("reflex during the equip"));
    throw controller.signal.reason;
  };
  await assert.rejects(
    useTemporaryWorkstation(f.bot, "crafting_table", { signal: controller.signal }, f.operations, async () => ({ status: "succeeded" }), f.failure, hold),
    /reflex during the equip/,
  );
  assert.deepEqual(hold.cells, [], "nothing was sent, so nothing is recorded");

  // A reflex puts a table in that very cell (the fixture world shows one there); the resume places its own.
  placeTableForReal(f);
  const result = await useTemporaryWorkstation(
    f.bot, "crafting_table", {}, f.operations, async () => ({ status: "succeeded" }), f.failure, hold,
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(f.calls, ["place", "place", "collect"], "the request's own table was placed, the reflex's was not taken for it");
});
