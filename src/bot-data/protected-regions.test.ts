import assert from "node:assert/strict";
import test from "node:test";
import { persistentBotData, temporaryBotData } from "../test-support/bot-data.js";
import { MAX_PROTECTED_REGIONS, ProtectedRegionStore, type RegionRequest } from "./protected-regions.js";

const house: RegionRequest = {
  dimension: "overworld", min: { x: -6, y: 63, z: -3 }, max: { x: 0, y: 70, z: 3 },
  owner: "Ayla", label: "small medieval house", reason: "My own house.", createdBy: "Ayla",
};

test("protecting stores a region once; the same box for the same owner returns it", (t) => {
  const store = new ProtectedRegionStore(temporaryBotData({ closeAfter: t }), "Ayla");
  const first = store.protect(house);
  assert.equal(first.kind, "created");
  assert.deepEqual(first.kind === "created" && first.region, {
    regionId: 1, dimension: "overworld", min: house.min, max: house.max, owner: "Ayla", label: "small medieval house",
    heldBy: "Ayla", peer: false,
  });
  const again = store.protect({ ...house, owner: "ayla", label: "renamed" });
  assert.equal(again.kind, "existing");
  assert.equal(store.list().length, 1);
  assert.equal(store.protect({ ...house, owner: "Tom" }).kind, "created", "another owner is another region");
});

test("a region over the side limit or past the count limit is refused", (t) => {
  const store = new ProtectedRegionStore(temporaryBotData({ closeAfter: t }), "Ayla");
  assert.deepEqual(store.protect({ ...house, max: { x: 64, y: 70, z: 3 } }), { kind: "too_large", side: 71 });
  for (let index = 0; index < MAX_PROTECTED_REGIONS; index += 1) {
    const x = index * 100;
    assert.equal(store.protect({ ...house, min: { ...house.min, x }, max: { ...house.max, x } }).kind, "created");
  }
  assert.deepEqual(store.protect(house), { kind: "limit_reached" });
});

test("regions persist with bot data and are removed by id", (t) => {
  const storage = persistentBotData(t);
  {
    using data = storage.open("regions-test");
    const store = new ProtectedRegionStore(data, "Ayla");
    store.protect(house);
    store.protect({ ...house, owner: "Tom", label: "Tom's place" });
  }
  using reopened = storage.open("regions-test");
  const store = new ProtectedRegionStore(reopened, "Ayla");
  assert.deepEqual(store.list().map((region) => region.label), ["small medieval house", "Tom's place"]);
  const removed = store.unprotect(1);
  assert.equal(removed.kind === "removed" && removed.region.label, "small medieval house");
  assert.deepEqual(store.unprotect(1), { kind: "not_found" });
  assert.deepEqual(store.list().map((region) => region.regionId), [2]);
  assert.equal(reopened.read("SELECT created_by_bot_id FROM protected_regions")[0]?.created_by_bot_id, "Ayla");
});

test("shared scope: a region another host wrote is a peer's after refresh(), and refresh() otherwise does not reload", (t) => {
  const storage = persistentBotData(t);
  const ayla = new ProtectedRegionStore(storage.open("shared-world"), "Ayla");
  const tom = new ProtectedRegionStore(storage.open("shared-world"), "Tom");
  ayla.refresh(); // opening Tom's connection wrote the file's metadata: start from a settled version
  ayla.protect(house);
  const before = ayla.list();
  assert.equal(ayla.refresh(), false, "its own write does not count as a change from elsewhere");
  assert.equal(ayla.list(), before);

  tom.protect({ ...house, owner: "Tom", label: "Tom's place", createdBy: "Tom" });
  assert.equal(ayla.list(), before, "nothing is seen before the refresh");
  assert.equal(ayla.refresh(), true);
  const after = ayla.list();
  assert.deepEqual(after.map((region) => [region.label, region.heldBy, region.peer]), [
    ["small medieval house", "Ayla", false],
    ["Tom's place", "Tom", true],
  ]);
  assert.equal(ayla.refresh(), false);
  assert.equal(ayla.list(), after);
});

test("unprotect of a region held by another bot returns not_held and keeps it", (t) => {
  const storage = persistentBotData(t);
  const ayla = new ProtectedRegionStore(storage.open("shared-world"), "Ayla");
  const tom = new ProtectedRegionStore(storage.open("shared-world"), "Tom");
  tom.protect({ ...house, owner: "Tom", createdBy: "Tom" });
  ayla.refresh();
  const outcome = ayla.unprotect(1);
  assert.equal(outcome.kind, "not_held");
  assert.equal(outcome.kind === "not_held" && outcome.region.heldBy, "Tom");
  assert.equal(ayla.list().length, 1);
  tom.refresh();
  assert.equal(tom.list().length, 1, "the region is still stored");
  assert.equal(tom.unprotect(1).kind, "removed");
});
