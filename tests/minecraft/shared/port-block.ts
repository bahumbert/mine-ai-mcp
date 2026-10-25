// The game/RCON port pairs (p, p+1) a daemon may use, all inside its own block.
import type { PortBlock } from "./config.ts";

export class PortPairs {
  readonly #leased = new Set<number>();

  constructor(private readonly block: PortBlock) {}

  /** The first port of the lowest free pair; the RCON port is the next one. */
  lease(): number {
    for (let port = this.block.first; port + 1 <= this.block.last; port += 2) {
      if (this.#leased.has(port)) continue;
      this.#leased.add(port);
      return port;
    }
    throw new Error(`no free port pair in the block ${this.block.first}-${this.block.last}`);
  }

  release(port: number): void {
    this.#leased.delete(port);
  }

  /** Whether a pair starting at `port` lies wholly inside the block. */
  contains(port: number): boolean {
    return port >= this.block.first && port + 1 <= this.block.last;
  }
}
