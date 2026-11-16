// For tests of code that must not wait on something slow: a call that does wait shows as false instead of hanging the test.

/**
 * Whether `promise` settles within `turns` turns of the event loop. Counted in turns, not milliseconds: a machine pause stretches
 * a wall-clock bound and fails the test, but never changes how many turns a promise chain needs.
 */
export async function settlesWithin(promise: Promise<unknown>, turns = 20): Promise<boolean> {
  const held = (async () => {
    for (let turn = 0; turn < turns; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
    return false;
  })();
  return Promise.race([promise.then(() => true), held]);
}
