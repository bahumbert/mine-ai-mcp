// Client processes for the tests of the clients booted ahead: tiny bun scripts that boot, crash or hang as a client host does, started through Mine Labs' own `spawnClientAhead`.
import { spawnClientAhead, type ClientAhead, type ClientCommandSpec } from "mine-labs";
import { clientBootedLine } from "../client-boot-marker.ts";

/** `boots`: says it booted and waits for init; `crashes`: dies on stderr before it boots (a missing import); `hangs`: never boots; `boots-then-dies`: boots, then exits while it waits. */
export type ClientScript = "boots" | "crashes" | "hangs" | "boots-then-dies";

const SOURCES: Record<ClientScript, string> = {
  boots: `process.stdout.write(${JSON.stringify(clientBootedLine())}); process.stdin.on("end", () => process.exit(0)); process.stdin.resume();`,
  crashes: `console.error("error: Cannot find module './missing-driver.ts'"); console.error("  at client-host.ts:7"); process.exit(1);`,
  hangs: `setInterval(() => {}, 1000);`,
  "boots-then-dies": `process.stdout.write(${JSON.stringify(clientBootedLine())}); setTimeout(() => process.exit(3), 150);`,
};

export interface ScriptedClient {
  readonly spec: ClientCommandSpec;
  readonly ahead: ClientAhead;
  readonly script: ClientScript;
}

/** A spawner that follows `plan` (one script per spawn, `boots` once it is used up) and remembers what it started. */
export class ScriptedClients {
  readonly spawned: ScriptedClient[] = [];
  readonly #plan: ClientScript[];

  constructor(plan: readonly ClientScript[] = []) {
    this.#plan = [...plan];
  }

  readonly spawn = (spec: ClientCommandSpec): ClientAhead => {
    const script = this.#plan.shift() ?? "boots";
    const ahead = spawnClientAhead({ ...spec, command: process.execPath, args: ["-e", SOURCES[script]], cwd: undefined });
    this.spawned.push({ spec, ahead, script });
    return ahead;
  };

  /** Kills what is still alive (a test's `finally`) and waits for the stdio to close. */
  async stopAll(): Promise<void> {
    for (const { ahead } of this.spawned) ahead.child.kill("SIGKILL");
    await Promise.all(this.spawned.map(({ ahead }) => ahead.closed));
  }
}

/** The client command of a scenario run by our host: the tuple a submission's clients are booted for. */
export function hostClient(driver = "drivers/a.ts", cwd = "/work/tests/minecraft", env: Record<string, string> = {}): ClientCommandSpec {
  return { command: "bun", args: ["client-host.ts", driver], env, cwd };
}
