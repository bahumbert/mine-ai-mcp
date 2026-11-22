import assert from 'node:assert/strict';
import test from 'node:test';

import {parsePickUpItemsRequest, pickUpItemsInputSchema, pickUpItemsResultSchema} from './contract.js';

test('pickup sightings accept a confirmed collector and require nullable collector evidence', () => {
  const sighting = {id: 1, item: 'gold_ingot', observedCount: 1, position: {x: 0, y: 0, z: 0}, outcome: 'taken_by_other', takenBy: 'piglin'};
  const pickup = {item: null, center: sighting.position, radius: 8, observed: 1, collected: 0, gainedByItem: {}, emptySlots: 1, sightings: [sighting], recovery: null};
  const result = {status: 'failed', error: 'no pickup', pickup};
  assert.throws(() => pickUpItemsResultSchema.parse({...result, pickup: {...pickup, sightings: [{...sighting, takenBy: undefined}]}}));
});

test('pickup area requires either all coordinates or none and caps its loaded radius', () => {
  assert.throws(() => pickUpItemsInputSchema.parse({x: 1, radius: 8}), /x, y, and z/);
  assert.throws(() => pickUpItemsInputSchema.parse({radius: 33}));
  assert.deepEqual(parsePickUpItemsRequest({item: 'cobblestone', x: 1, y: 2, z: 3}), {
    item: 'cobblestone',
    center: {x: 1, y: 2, z: 3},
    radius: 8,
    recoverDeathItems: false,
  });
});

test('death recovery owns its centre and rejects conflicting coordinates', () => {
  assert.throws(
      () => pickUpItemsInputSchema.parse({recover_death_items: true, x: 1, y: 2, z: 3}), /retained death position/);
  assert.deepEqual(parsePickUpItemsRequest({recover_death_items: true}), {
    radius: 8,
    recoverDeathItems: true,
  });
});
