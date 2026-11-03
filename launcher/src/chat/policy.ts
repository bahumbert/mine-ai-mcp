// Who may command and how often (spec D5). Pure: the caller supplies the clock and the rules.
import { PLAYER_NAME } from "./parse.ts";

export interface CommandLine {
  readonly username: string;
  readonly channel: "chat" | "whisper";
  readonly message: string;
}

export interface GateRules {
  /** Local server on loopback: every player may command. */
  readonly anyoneMay: boolean;
  /** `commands.players` of the settings. */
  readonly players: readonly string[];
  /** Usernames of our own bots and the listener: what they say is never a command. */
  readonly ourNames: readonly string[];
}

/** A flood of distinct names must not grow the records without bound: past this many, expired ones are dropped. */
const PRUNE_ABOVE_SENDERS = 256;

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Decides per command line: run it, whisper a refusal, or ignore it. */
export class CommandGate {
  private readonly lastRunAt = new Map<string, number>();
  private readonly lastRefusalAt = new Map<string, number>();

  constructor(private readonly limits: { now(): number; cooldownMs: number; refusalEveryMs: number }) {}

  check(line: CommandLine, rules: GateRules): "run" | "refuse" | "ignore" {
    if (!PLAYER_NAME.test(line.username)) return "ignore";
    if (rules.ourNames.some((ours) => sameName(ours, line.username))) return "ignore";
    const sender = line.username.toLowerCase();
    const now = this.limits.now();
    this.pruneExpired(now);
    if (!rules.anyoneMay && !rules.players.some((player) => sameName(player, line.username))) return this.refuseOnce(sender, now);
    const last = this.lastRunAt.get(sender);
    if (last !== undefined && now - last < this.limits.cooldownMs) return "ignore";
    this.lastRunAt.set(sender, now);
    return "run";
  }

  /** Senders with a record left; the pruning test reads it. */
  trackedSenders(): number {
    return new Set([...this.lastRunAt.keys(), ...this.lastRefusalAt.keys()]).size;
  }

  private refuseOnce(sender: string, now: number): "refuse" | "ignore" {
    const last = this.lastRefusalAt.get(sender);
    if (last !== undefined && now - last < this.limits.refusalEveryMs) return "ignore";
    this.lastRefusalAt.set(sender, now);
    return "refuse";
  }

  private pruneExpired(now: number): void {
    if (this.lastRunAt.size + this.lastRefusalAt.size <= PRUNE_ABOVE_SENDERS) return;
    for (const [sender, at] of this.lastRunAt) if (now - at >= this.limits.cooldownMs) this.lastRunAt.delete(sender);
    for (const [sender, at] of this.lastRefusalAt) if (now - at >= this.limits.refusalEveryMs) this.lastRefusalAt.delete(sender);
  }
}
