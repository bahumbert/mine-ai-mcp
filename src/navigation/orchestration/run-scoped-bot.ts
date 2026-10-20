/**
 * One run's view of the shared bot, withdrawn when the run is abandoned.
 *
 * An abandoned run (its owner is gone: a cancelled action that waits for a physics tick that does not come) is still
 * a live promise chain. When ticks return it unwinds, and its cleanup clears "the owned controls" of the one bot it
 * shares with the run that started after it. Handing each run a scoped view, and revoking it when the run is
 * abandoned, makes the old run's later writes do nothing: its holds are released and its controls cleared at that
 * moment, and nothing it does after reaches the body. Reads still answer.
 */
import type { MovementPreparation, NavigationBot } from "../bot.js";

export interface RunScopedBot {
  readonly bot: NavigationBot;
  /** Release the holds this view handed out, clear the controls, and turn every later write into a no-op. Idempotent. */
  revoke(): void;
  readonly revoked: boolean;
}

const REVOKED = "The run was abandoned; its body now belongs to another run.";

export function createRunScopedBot(shared: NavigationBot): RunScopedBot {
  let revoked = false;
  const holds = new Set<() => void>();
  const bot: NavigationBot = {
    observe: () => shared.observe(),
    movementSnapshot: () => shared.movementSnapshot(),
    subscribePhysicsTick: (listener) => shared.subscribePhysicsTick(listener),
    describeMovementFailure: (step) => shared.describeMovementFailure(step),
    stabilize: (signal) => shared.stabilize(signal),
    get ownedControlCount() {
      return shared.ownedControlCount;
    },
    ...(shared.longestBreakDurationMs && { longestBreakDurationMs: (operation) => shared.longestBreakDurationMs!(operation) }),
    prepareMovement: async (...args): Promise<MovementPreparation> =>
      revoked ? { kind: "failed", observation: REVOKED } : shared.prepareMovement(...args),
    startEffect: (...args) =>
      revoked
        ? { issued: false, completion: Promise.resolve({ kind: "failed", observation: REVOKED }), cancel: () => undefined }
        : shared.startEffect(...args),
    centerOnCell: async (cell, signal) => !revoked && (await shared.centerOnCell(cell, signal)),
    applyMovementSteering: (target) => {
      if (!revoked) shared.applyMovementSteering(target);
    },
    applyMovementControls: (intent) => {
      if (!revoked) shared.applyMovementControls(intent);
    },
    clearOwnedControls: () => {
      if (!revoked) shared.clearOwnedControls();
    },
    holdPosition: (world) => {
      if (revoked) return () => undefined;
      const release = shared.holdPosition(world);
      const once = () => {
        if (holds.delete(once)) release();
      };
      holds.add(once);
      return once;
    },
  };
  return {
    bot,
    revoke() {
      if (revoked) return;
      // Withdrawn first: a release or a clear that throws must not leave the old run holding a live view.
      revoked = true;
      for (const release of [...holds]) release();
      shared.clearOwnedControls();
    },
    get revoked() {
      return revoked;
    },
  };
}
