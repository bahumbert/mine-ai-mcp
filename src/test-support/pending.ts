/**
 * Whether `pending` has ended (resolved or rejected), read at any time. The rejection is handled here only so the
 * watch itself reports nothing: the test still awaits `pending` to see the error.
 */
export function watch<T>(pending: Promise<T>): { readonly over: boolean } {
  const state = { over: false };
  void pending.then(
    () => (state.over = true),
    () => (state.over = true),
  );
  return state;
}
