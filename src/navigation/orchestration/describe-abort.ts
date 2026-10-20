/**
 * What an abort reason says, in words.
 *
 * Callers abort with a string; `AbortSignal.timeout` aborts with a
 * `TimeoutError`; a bare `abort()` aborts with an `AbortError`.
 */
export function describeAbort(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) {
    if (reason.name === "TimeoutError") return "navigation timeout";
    if (reason.name === "AbortError") return "cancelled";
    return reason.message;
  }
  return "cancelled";
}
