import type { Bot } from "mineflayer";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { recordCombatResourceReceipt } from "../../runtime/combat-resource-receipts.js";
import { serverTickPace, type TickMark } from "../../world/server-tick-pace.js";
import { serverPacedWallMs } from "../../world/world-age.js";
import { monotonicNow } from "../../utils/index.js";

/** A vanilla shield blocks only after five ticks of use. */
export const SHIELD_READY_TICKS = 5;

export interface BowDraw extends Disposable {
  readonly startedAt: TickMark;
  release(): void;
}

/** One engagement's commanded item use. Target and weapon decisions stay with the controller. */
export class CombatItemUse {
  #posture: "idle" | "shield" | "drawing" = "idle";
  readonly #bot: Bot;
  readonly #holdFacing: (ticks: number, wallEnd?: number) => Promise<void | "held" | "interrupted">;

  constructor(bot: Bot, holdFacing: (ticks: number, wallEnd?: number) => Promise<void | "held" | "interrupted">,
    private readonly trace: (event: { stage: string; posture: string; usingHeldItem: boolean }) => void = () => {}) {
    this.#bot = bot;
    this.#holdFacing = holdFacing;
  }
  private record(stage: string): void {
    this.trace({ stage, posture: this.#posture, usingHeldItem: this.#bot.usingHeldItem });
  }

  get shieldRaised(): boolean {
    return this.#posture === "shield";
  }
  get drawingBow(): boolean { return this.#posture === "drawing"; }

  /** Navigation can change slots or use an item; its return does not prove our old guard survived. */
  invalidateShield(): void {
    if (this.#posture === "shield") this.#posture = "idle";
    this.record("shield_invalidated");
  }

  async raiseShield(stop: () => boolean = () => false): Promise<void> {
    if (this.shieldRaised) { this.record("shield_activation_skipped"); return; }
    this.#cancelDraw();
    this.activateShield();
    const pace = serverTickPace(this.#bot), mark = pace.mark();
    const wallEnd = mark.ms + serverPacedWallMs(SHIELD_READY_TICKS);
    let clientTicks = 0;
    while (!stop() && !pace.ready(mark, SHIELD_READY_TICKS, clientTicks) &&
        monotonicNow() < wallEnd) {
      if (await this.#holdFacing(1, wallEnd) === "interrupted" || !this.shieldRaised) return;
      clientTicks++;
    }
  }

  /** One owner for shield readiness and waiting; the caller assesses geometry and its own lifecycle. */
  async guardUntil<Outcome>(assess: () => Outcome | null): Promise<Outcome> {
    await this.raiseShield(() => assess() !== null);
    for (;;) {
      const outcome = assess();
      if (outcome !== null) return outcome;
      await this.#holdFacing(1);
    }
  }

  /** Reassert off-hand use after a swing without paying readiness again. */
  activateShield(): void {
    this.#bot.activateItem(true);
    this.#posture = "shield";
    this.record("shield_activated");
  }

  lowerShield(): void {
    this.#bot.deactivateItem();
    this.#posture = "idle";
    this.record("shield_lowered");
  }

  /** Leaving the draw's scope without releasing an arrow cancels it. */
  drawBow(): BowDraw {
    this.#cancelDraw();
    // Invalidating local posture does not release server-side shield use.
    // End that use before requesting the other hand, or vanilla ignores the draw.
    this.lowerShield();
    this.#bot.activateItem();
    this.#posture = "drawing";
    this.record("bow_draw_started");
    return {
      startedAt: serverTickPace(this.#bot).mark(),
      release: () => {
        this.#bot.deactivateItem();
        recordCombatResourceReceipt(this.#bot, { kind: "arrow_release_command" });
        this.#posture = "idle";
        this.record("bow_released");
      },
      [Symbol.dispose]: () => this.#cancelDraw(),
    };
  }

  #cancelDraw(): void {
    if (this.#posture !== "drawing") return;
    // Changing slots cancels a bow draw; releasing use would fire it.
    const slot = this.#bot.quickBarSlot;
    this.#bot.setQuickBarSlot((slot + 1) % 9);
    this.#bot.setQuickBarSlot(slot);
    this.#posture = "idle";
    this.record("bow_cancelled");
  }

  /** Settle controls and repeat release after a tick, as the existing cleanup requires. */
  async neutralise(settleMovement: () => Promise<void>, ownerSignal: AbortSignal): Promise<void> {
    try {
      this.#cancelDraw();
      this.lowerShield();
    } finally {
      try {
        try {
          await waitForPhysicsTicks(this.#bot, 1, ownerSignal);
        } catch (cause) {
          if (!ownerSignal.aborted) throw cause;
        }
        this.lowerShield();
      } finally {
        // A health cancellation can precede the same hit's velocity packet.
        // Finish item release, then the landing, then relinquish controls.
        // There must be no awaited cleanup after the physical handoff.
        try {
          await settleMovement();
        } finally {
          this.#bot.clearControlStates();
        }
      }
    }
  }
}
