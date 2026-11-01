// What the player reads when a `fetch` fails: the cause, without the hint Bun adds for programmers.

/** Bun ends its fetch errors with this sentence ("... For more information, pass `verbose: true` in the second argument to fetch()"). */
const BUN_VERBOSE_HINT = /\s*For more information, pass `verbose: true`.*$/su;

/**
 * The plain cause of a failed fetch: the message cut before Bun's hint; when nothing is left, the message of the
 * `cause` chain (each error once), else the text of a string cause, else the error's name (never an empty text).
 */
export function fetchErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const message = current.message.replace(BUN_VERBOSE_HINT, "").trim();
    if (message !== "") return message;
    current = current.cause;
  }
  return typeof current === "string" && current !== "" ? current : error.name;
}
