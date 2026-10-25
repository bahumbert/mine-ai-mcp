// What the pool, scheduler and trial runner need of one running Minecraft server (the real one wraps a Mine Labs server).

export interface ScenarioServer {
  readonly id: string;
  /** `shared`: lane trials at shifted offsets; `single`: one scenario at offset 0, no arena. */
  readonly kind: "shared" | "single";
  readonly gamePort: number;
  readonly heapMb: number;
  /** One RCON command (10 s bound inside Mine Labs). */
  command(command: string): Promise<string>;
  /** The java process, once it runs; null when it cannot be found. */
  javaPid(): number | null;
  stop(): Promise<void>;
}
