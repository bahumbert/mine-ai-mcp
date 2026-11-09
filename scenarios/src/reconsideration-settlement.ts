/** Settle a reconsideration hunt after proof or a fixture failure. */
export async function settleReconsiderationHunt<T>(
  hunt: Promise<T>, child: AbortController, failure: Promise<never>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startTimer = () => {};
  const timeout = new Promise<never>((_, reject) => {
    startTimer = () => { timer = setTimeout(() => reject(new Error("hunt did not settle after cancel")), 10_000); };
    if (child.signal.aborted) startTimer(); else child.signal.addEventListener("abort", startTimer, { once: true });
  });
  const failed = failure.catch((reason: unknown) => {
    child.abort(reason);
    return { reason };
  });
  try {
    const result = await Promise.race([hunt.then((value) => ({ value })), failed, timeout]);
    if ("value" in result) return result.value;
    await Promise.race([hunt.then(() => {}, () => {}), timeout]);
    throw result.reason;
  } finally {
    child.signal.removeEventListener("abort", startTimer);
    if (timer) clearTimeout(timer);
  }
}
