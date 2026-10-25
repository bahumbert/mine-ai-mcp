// The daemon's unix socket: one JSON request per connection, replies streamed back until the work is done.
import net from "node:net";
import { unlink } from "node:fs/promises";
import { daemonListens } from "./daemon-client.ts";
import { decodeClientMessage, encodeMessage, LineReader, type ClientMessage, type DaemonMessage, type SubmitMessage } from "./protocol.ts";
import type { RunningSubmission } from "./submission-handler.ts";

export interface SocketHandlers {
  submit(message: SubmitMessage, send: (reply: DaemonMessage) => void): RunningSubmission;
  status(): string;
  requestStop(): void;
  isStopping(): boolean;
  /** A connection opened or a submission ended: the daemon is not idle. */
  touch(): void;
}

export interface SocketServer { close(): Promise<void> }

/** Removes a stale socket file; refuses when another daemon still listens on it. */
async function claimSocket(socketPath: string): Promise<void> {
  if (await daemonListens(socketPath)) throw new Error(`another daemon already listens on ${socketPath}`);
  await unlink(socketPath).catch(() => undefined);
}

function answer(socket: net.Socket, handlers: SocketHandlers, state: { submission?: RunningSubmission }, line: string): void {
  const send = (reply: DaemonMessage): void => { if (!socket.destroyed) socket.write(encodeMessage(reply)); };
  let message: ClientMessage;
  try {
    message = decodeClientMessage(line);
  } catch (error) {
    send({ type: "error", text: `unreadable request: ${error instanceof Error ? error.message : String(error)}` });
    socket.end();
    return;
  }
  if (message.type === "stop") {
    handlers.requestStop();
    send({ type: "stopping" });
    socket.end();
  } else if (message.type === "status") {
    send({ type: "status", text: handlers.status() });
    socket.end();
  } else if (handlers.isStopping()) {
    send({ type: "error", text: "the daemon is stopping and exits once its trials end (up to about two minutes); submit again after that" });
    socket.end();
  } else {
    const running = handlers.submit(message, send);
    state.submission = running;
    void running.finished.finally(() => { handlers.touch(); socket.end(); });
  }
}

export async function serveSocket(socketPath: string, handlers: SocketHandlers): Promise<SocketServer> {
  await claimSocket(socketPath);
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    handlers.touch();
    const reader = new LineReader();
    const state: { submission?: RunningSubmission } = {};
    socket.on("data", chunk => { for (const line of reader.push(chunk.toString())) answer(socket, handlers, state, line); });
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); state.submission?.connectionClosed(); });
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(socketPath, done); });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(done => server.close(() => done()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
