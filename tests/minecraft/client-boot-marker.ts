// The line a client host writes once its driver is loaded and it waits for `init`: the daemon boots hosts ahead and times their boot from it.
import { encodeClientMessage } from "mine-labs/client";

export const CLIENT_BOOTED_MESSAGE = "client host booted, waiting for init";

/** Bump on any change to the booted line, `init` handling or `MINE_AI_ARENA` decoding: the daemon lets another source root's host into a lane only when it speaks the same number (`placement.ts`). */
export const CLIENT_HOST_PROTOCOL = 1;

/** A protocol `log` event, so Mine Labs (which logs it) and an older daemon go on as before. */
export function clientBootedLine(): string {
  return encodeClientMessage({ type: "log", message: CLIENT_BOOTED_MESSAGE });
}
