/**
 * Checks that read what the server answers run on a fake server that answers late (plan 2026-10-23-shared-scenario-server T7d2 item 1):
 * a check that waits a fixed wall time and then reads is red on a server behind its schedule (another lane's clone stalls the server thread
 * 0.16-0.9 s), and green here only if it waits for the answer. Each was red on its old code at this lag through its 400 ms read (consume-food, shield-raised, projectile-hit-bot); the same table could join T7d4's `answer-waits.test.ts` (lag by check name).
 */
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { contractCheckNamed } from "./checks.ts";
import { fakeHarnessFor } from "./fake-harness.ts";
import { fakeContractSubject } from "./subject.ts";

/** The checks whose answer comes after the call they wait on: the others (`explosion-knockback`, `place-block-with-options`, `unequip-hand`) read what their own awaited call brought, which a fake answers in one tick whatever its lag. */
const LAGS_MS: Readonly<Record<string, number>> = {
  "consume-food": 450,
  "projectile-hit-bot": 450,
  "shield-raised": 450,
};

for (const [name, lagMs] of Object.entries(LAGS_MS)) {
  test(`contract ${name} holds on a fake server that answers ${lagMs} ms late`, async () => {
    const check = contractCheckNamed(name);
    const harness = fakeHarnessFor(check.fixture, arenaFrame(ZERO_ARENA), {}, lagMs);
    using _installed = harness.clock.install();
    await check.run(fakeContractSubject(harness, arenaFrame(ZERO_ARENA)));
  });
}
