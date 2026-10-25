/**
 * Runs a write whose failure must not escape a game listener (a locked or full database, a store closed at shutdown):
 * the event is lost, the host keeps running. Each distinct failure is written to stderr once per source as
 * `[<source>] <message>`; a success lets the same message be written again. One guard per observer per bot, so
 * twenty bots share no state.
 */
export function guardObservedWrite(source: string): (write: () => void) => void {
  let lastMessage: string | null = null;
  return (write) => {
    try {
      write();
      lastMessage = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastMessage) process.stderr.write(`[${source}] ${message}\n`);
      lastMessage = message;
    }
  };
}
