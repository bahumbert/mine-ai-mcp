/** A helper other than a test that installs a mocked fake clock for its caller: `fake-clock.test.ts` checks that the clock names the test, not this file. */
import type { FakeClock } from "./fake-clock.js";

export function installClockForTest(clock: FakeClock): Disposable {
  // The wrapper after the call keeps this frame in the stack: Bun 1.4.2 (JavaScriptCore) drops the frame of a function that only returns what it called (seen 2026-10-25 with `return clock.install()` and with `const x = clock.install(); return x`).
  const installed = clock.install();
  return { [Symbol.dispose]: () => installed[Symbol.dispose]() };
}
