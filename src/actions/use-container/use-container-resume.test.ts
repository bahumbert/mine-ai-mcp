import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { scene } from "../../test-support/use-container-scene.js";
import { OpenedContainer } from "./opened-container.js";
import { beginUseContainer, type UseContainerDependencies, useContainer } from "./use-container.js";

// A request a reflex splits into attempts: what each attempt moves, and what the next one asks for.

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function containerAttempts(
  scenery: ReturnType<typeof scene>,
  request: Parameters<typeof useContainer>[2],
  dependencies: UseContainerDependencies = scenery.dependencies,
) {
  const run = beginUseContainer(scenery.bot, scenery.data, request, undefined, dependencies);
  return (signal?: AbortSignal) => scenery.settled(run({ signal }));
}

/**
 * Records what each `transfer` is asked to move (the count the action asks of the window), and cuts the first attempt off as the server
 * receives its `clicks`-th click (a reflex took the body): the owner is aborted there, the stack in hand goes back, the call rejects with the
 * reason and the window shows what the clicks already did. With `clicks` null every call completes.
 */
function cutOffAfterClicks(t: TestContext, scenery: ReturnType<typeof scene>, owner: AbortController, clicks: number | null): number[] {
  const asked: number[] = [];
  const transfer = OpenedContainer.prototype.transfer;
  t.mock.method(OpenedContainer.prototype, "transfer", function (this: OpenedContainer, ...args: Parameters<OpenedContainer["transfer"]>) {
    asked.push(args[2]);
    return transfer.apply(this, args);
  });
  let received = 0;
  if (clicks !== null) scenery.harness.windows.onClickReceived(() => void (++received === clicks && owner.abort(new Error("hunger reflex"))));
  return asked;
}

const CHEST = { x: 1, y: 64, z: 1 } as const;

test("a withdrawal of three stacks cut off after the first asks only for the other two", async (t) => {
  const carried = { cobblestone: 0 };
  const scenery = scene(t, { contents: [0, 1, 2].map((slot) => ({ slot, name: "cobblestone", count: 64 })), carried });
  const owner = new AbortController();
  // The first stack's pick-up and its click onto the inventory are the first two clicks; the abort lands with the second.
  const asked = cutOffAfterClicks(t, scenery, owner, 2);
  const attempt = containerAttempts(scenery, { operation: "withdraw", ...CHEST, items: [{ itemName: "cobblestone", count: 192 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.deepEqual(asked, [192, 128]);
  assert.equal(scenery.carried("cobblestone"), 192);
  assert.equal(result.status, "succeeded");
  if (result.container?.operation !== "withdraw") assert.fail("expected withdraw evidence");
  assert.equal(result.container.transfers[0]?.transferred, 192);
  assert.equal(scenery.container.closed, true);
});

test("a deposit cut off mid-transfer moves only the rest next time", async (t) => {
  const carried = { cobblestone: 20 };
  const scenery = scene(t, { block: "barrel", contents: 0, carried });
  const owner = new AbortController();
  // Pick-up and two single clicks put 2 in the barrel; the rest of the stack goes back before the call rejects.
  const asked = cutOffAfterClicks(t, scenery, owner, 3);
  const attempt = containerAttempts(scenery, { operation: "deposit", ...CHEST, items: [{ itemName: "cobblestone", count: 6 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  assert.equal(scenery.container.contents.find(({ name }) => name === "cobblestone")?.count, 2);
  assert.equal(scenery.carried("cobblestone"), 18, "the rest of the stack is back in the inventory");
  const result = await attempt(new AbortController().signal);

  assert.deepEqual(asked, [6, 4]);
  assert.equal(scenery.carried("cobblestone"), 14);
  assert.equal(result.status, "succeeded");
});

test("a chest another bot emptied between attempts gives what it had left, as a partial", async (t) => {
  const carried = { cobblestone: 0 };
  const scenery = scene(t, { contents: [0, 1, 2].map((slot) => ({ slot, name: "cobblestone", count: 64 })), carried });
  const owner = new AbortController();
  cutOffAfterClicks(t, scenery, owner, 2);
  const attempt = containerAttempts(scenery, { operation: "withdraw", ...CHEST, items: [{ itemName: "cobblestone", count: 192 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  scenery.container.contents = [];
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "partial");
  if (result.container?.operation !== "withdraw") assert.fail("expected withdraw evidence");
  assert.equal(result.container.transfers[0]?.transferred, 64);
  assert.equal(scenery.carried("cobblestone"), 64);
});

test("a second call after a completed withdrawal returns the success without moving anything", async (t) => {
  const carried = { cobblestone: 0 };
  const scenery = scene(t, { contents: [{ slot: 0, name: "cobblestone", count: 64 }], carried });
  const asked = cutOffAfterClicks(t, scenery, new AbortController(), null);
  const attempt = containerAttempts(scenery, { operation: "withdraw", ...CHEST, items: [{ itemName: "cobblestone", count: 64 }] });

  const first = await attempt();
  const second = await attempt();

  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.deepEqual(asked, [64]);
  assert.equal(scenery.carried("cobblestone"), 64);
  if (second.container?.operation !== "withdraw") assert.fail("expected withdraw evidence");
  assert.equal(second.container.transfers[0]?.transferred, 64);
});

test("a deposit resumed after the hunger reflex ate some of the same food still puts the full count in the chest", async (t) => {
  const carried = { bread: 20 };
  const scenery = scene(t, { block: "barrel", contents: 0, carried });
  const owner = new AbortController();
  cutOffAfterClicks(t, scenery, owner, 3);
  const attempt = containerAttempts(scenery, { operation: "deposit", ...CHEST, items: [{ itemName: "bread", count: 5 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  scenery.addCarried("bread", -2); // the reflex ate two between the attempts: the inventory fell, the chest did not
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  if (result.container?.operation !== "deposit") assert.fail("expected deposit evidence");
  assert.equal(result.container.transfers[0]?.transferred, 5);
  assert.equal(scenery.container.contents.find(({ name }) => name === "bread")?.count, 5);
  assert.equal(scenery.carried("bread"), 13);
});

test("a withdrawal resumed after planks were picked up from the ground still takes the full count from the chest", async (t) => {
  const carried = { oak_planks: 0 };
  const scenery = scene(t, { contents: [{ slot: 0, name: "oak_planks", count: 20 }], carried });
  const owner = new AbortController();
  cutOffAfterClicks(t, scenery, owner, 3);
  const attempt = containerAttempts(scenery, { operation: "withdraw", ...CHEST, items: [{ itemName: "oak_planks", count: 5 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  scenery.addCarried("oak_planks", 4); // picked up during the rescue: the inventory rose, the chest did not
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  if (result.container?.operation !== "withdraw") assert.fail("expected withdraw evidence");
  assert.equal(result.container.transfers[0]?.transferred, 5);
  assert.equal(scenery.container.contents.find(({ name }) => name === "oak_planks")?.count, 15);
  assert.equal(scenery.carried("oak_planks"), 9);
});

test("a resumed deposit while another bot also puts items in the chest credits no more than the inventory lost", async (t) => {
  const carried = { bread: 20 };
  const scenery = scene(t, { block: "barrel", contents: 0, carried });
  const owner = new AbortController();
  const asked = cutOffAfterClicks(t, scenery, owner, 3);
  const attempt = containerAttempts(scenery, { operation: "deposit", ...CHEST, items: [{ itemName: "bread", count: 5 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  scenery.container.contents = [...scenery.container.contents, { slot: 5, name: "bread", count: 5 }]; // another bot's own deposit
  await attempt(new AbortController().signal);

  assert.deepEqual(asked, [5, 3]);
});
