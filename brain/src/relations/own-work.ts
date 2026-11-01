// What the agent's own steps and hand-offs explain in the bag: a gain that lands after the step ended is still its own.

/**
 * The yields and the own-work flag of the steps and hand-offs, for the relations tick (`TradeController.tick`).
 * What ended is handed to the tick a look starts, and stays for one more counted tick: an item entity a step knocked
 * loose and picked up a moment later (a sapling, an apple) is not a partner's payment. Only a tick that ran with a
 * baseline (`TradeController.countedTicks()` moved) uses a tick of the window up; a tick that failed before counting
 * does not. What ended while a tick ran was not handed to it and waits for the next look.
 */
export class OwnWork {
  /** The items the running step is out to get. */
  private running: ReadonlySet<string> = new Set();
  /** A step or hand-off is running. */
  private active_ = false;
  /** Ended since the last look that started a tick; then handed to the tick in flight; then kept for one more tick. */
  private sinceLook: ReadonlySet<string> = new Set();
  private inFlight: ReadonlySet<string> = new Set();
  private lastTick: ReadonlySet<string> = new Set();
  private ownSinceLook = false;
  private ownInFlight = false;
  private ownLastTick = false;
  private counted = 0;

  startStep(yields: ReadonlySet<string>): void {
    this.running = yields;
    this.active_ = true;
  }

  /** The step is over: its yields wait for the ticks that see the inventory after it (a look during the step must not clear them). */
  endStep(): void {
    this.sinceLook = new Set([...this.sinceLook, ...this.running]);
    this.running = new Set();
    this.endOwnWork();
  }

  /** A hand-off starts (it has no yields: its gains are the bot's own unless a trade is owed them). */
  startOwnWork(): void {
    this.active_ = true;
  }

  endOwnWork(): void {
    this.active_ = false;
    this.ownSinceLook = true;
  }

  /** A look started a tick on `yields()` and `active()`: what had ended is now that tick's. */
  handedOver(): void {
    this.inFlight = new Set([...this.inFlight, ...this.sinceLook]);
    this.ownInFlight ||= this.ownSinceLook;
    this.sinceLook = new Set();
    this.ownSinceLook = false;
  }

  /** Called before each look with `countedTicks()`: when it moved, the tick that counted had what was handed over, and it stays for one more. */
  advance(countedTicks: number): void {
    if (countedTicks === this.counted) return;
    this.counted = countedTicks;
    this.lastTick = this.inFlight;
    this.ownLastTick = this.ownInFlight;
    this.inFlight = new Set();
    this.ownInFlight = false;
  }

  /** Nothing is open to trade, so no gain is counted: what ended is forgotten. */
  idle(): void {
    this.sinceLook = new Set();
    this.inFlight = new Set();
    this.lastTick = new Set();
    this.ownSinceLook = false;
    this.ownInFlight = false;
    this.ownLastTick = false;
  }

  /** The items whose gains are the bot's own for the next tick. */
  yields(): ReadonlySet<string> {
    return new Set([...this.running, ...this.sinceLook, ...this.inFlight, ...this.lastTick]);
  }

  /** Whether every gain of the next tick is the bot's own (except what an open trade is owed). */
  active(): boolean {
    return this.active_ || this.ownSinceLook || this.ownInFlight || this.ownLastTick;
  }
}
