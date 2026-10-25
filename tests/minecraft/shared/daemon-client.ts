// The submitter's side of the socket: connect, send one request, stream the daemon's messages until it closes.
import net from "node:net";
import { decodeDaemonMessage, encodeMessage, LineReader, type ClientMessage, type DaemonMessage } from "./protocol.ts";

/** Resolves true when something accepts connections on the socket. */
export function daemonListens(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

export interface Exchange {
  /** Resolves when the daemon closed the connection (or this side did through `close`). */
  readonly closed: Promise<void>;
  close(): void;
}

/** Sends `request` and calls `onMessage` for each reply line; a reply the daemon sends that does not parse is reported as an error message. */
export function exchange(socketPath: string, request: ClientMessage, onMessage: (message: DaemonMessage) => void): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const reader = new LineReader();
    const closed = new Promise<void>(done => socket.once("close", () => done()));
    socket.once("error", reject);
    socket.on("data", chunk => {
      for (const line of reader.push(chunk.toString())) {
        try {
          onMessage(decodeDaemonMessage(line));
        } catch (error) {
          onMessage({ type: "error", text: `unreadable daemon message: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    });
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => {});
      socket.write(encodeMessage(request));
      resolve({ closed, close: () => socket.destroy() });
    });
  });
}
