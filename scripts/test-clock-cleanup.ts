/**
 * At the start of every test, gives back the global timers a fake clock a finished (or timed-out) test left installed.
 *
 * Why: Bun fails a test at its time limit but lets its body run on, and it runs no hook of that test (`after` does not
 * run; `onTestFinished` hangs in a `node:test` file; probed 2026-11-14, spec `.agent/specs/2026-11-14-tests-quick-wins.md`
 * D2). A clock that test had installed would still hold `setTimeout` and `Date` when the next test starts, so the next
 * test, with or without a clock of its own, would run on mocked timers.
 *
 * A global `beforeEach` reaches `node:test` tests too (probed); one registered in a module that several test files
 * import reaches the first importing file only, hence a preload. It runs before any `beforeEach` of a test file, so a
 * clock a file's own `beforeEach` installs is not touched; a clock installed in a `before`/`beforeAll` is (none in the
 * repository: install in the test or in `beforeEach`). `src/test-support/fake-bot/fake-clock.ts` publishes the function
 * to call under the same `Symbol.for` key (`src/` is typechecked with Node types only, so it cannot import this file).
 * Besides restoring the clock, that function retires every clock a finished test left running an `advance` or `settle`
 * (a body Bun let run on past its limit): those calls stop and never settle, so an orphan pump cannot throw `did not
 * settle` or `Invalid state: You should enable MockTimers first` into the next test or file (spec 2026-11-18-unit-reds D1).
 *
 * Loaded by `bunfig.toml` (`[test] preload`) beside `test-limit.ts`, not inside it: a child `bun test` of
 * `fake-clock-timeout.test.ts` loads only this file, so its own `--timeout` stays in force. It lives in `scripts/` for
 * the Bun types, as `test-limit.ts` does.
 */
import { beforeEach } from "bun:test";

const restoreLeftoverClockKey = Symbol.for("mine-ai.restore-leftover-fake-clock");

beforeEach(() => {
  (globalThis as { [restoreLeftoverClockKey]?: () => void })[restoreLeftoverClockKey]?.();
});
