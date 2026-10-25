// Servers that answer nothing and start instantly, for the pool, scheduler and daemon tests (the game is never run).
import type { ServerFactory, ServerRequest } from "./pool.ts";
import type { ScenarioServer } from "./scenario-server.ts";

export class FakeServer implements ScenarioServer {
  readonly commands: string[] = [];
  stopped = false;
  /** What `command` answers, by command; a command not listed answers nothing. */
  readonly replies = new Map<string, string | Error>();
  /** The answer to a command with no entry in `replies`. */
  defaultReply: (command: string) => string = () => "";
  readonly kind: ScenarioServer["kind"];
  readonly heapMb: number;
  readonly gamePort: number;

  constructor(readonly id: string, request: ServerRequest, port: number) {
    this.kind = request.kind;
    this.heapMb = request.heapMb;
    this.gamePort = port;
  }

  async command(command: string): Promise<string> {
    this.commands.push(command);
    const reply = this.replies.get(command) ?? this.defaultReply(command);
    if (reply instanceof Error) throw reply;
    return reply;
  }

  javaPid(): number | null { return 4242; }

  async stop(): Promise<void> { this.stopped = true; }
}

export class FakeFactory implements ServerFactory {
  readonly created: FakeServer[] = [];
  failNextStart = false;
  /** Called with each server right after it is made. */
  onCreate: ((server: FakeServer) => void) | null = null;
  /** When set, `create` waits for it: a server that is still starting. */
  startGate: Promise<void> | null = null;

  async create(request: ServerRequest): Promise<ScenarioServer> {
    await this.startGate;
    if (this.failNextStart) { this.failNextStart = false; throw new Error("no port"); }
    const server = new FakeServer(request.id, request, 25_400 + this.created.length * 2);
    this.created.push(server);
    this.onCreate?.(server);
    return server;
  }
}
