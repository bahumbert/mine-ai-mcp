/**
 * The default time limit of every test: 30 s. A hang detector, not a speed check: a test that needs a time check
 * asserts it on a fake clock (`src/test-support/fake-bot/`).
 *
 * Loaded by `bunfig.toml` (`[test] preload`) before any test file, so it covers every `bun test` run from the
 * repository root. Bun 1.4.2 applies this to the first file only, so `test-fast` also passes the same value by CLI
 * for later files (2026-11-16). Bun ignores `[test] timeout` in bunfig.toml. A test's own `{ timeout }`, and a file's own `setDefaultTimeout`
 * (`launcher/src/build/bundle.test.ts`), keep theirs.
 *
 * Numbers (audit `test-audit.md:408,420`): under load 50 the slowest default-limited test took 9.8 s; at 5 s two tests
 * failed and caused 5 knock-on reds; at 30 s one fail remains (an assertion). 30 s is 3x the worst measured.
 *
 * It lives in `scripts/` because this project's typecheck has the Bun types (`scripts/tsconfig.json`); `src/`,
 * `scenarios/`, `tests/` and `brain/` use Node types only.
 */
import { setDefaultTimeout } from "bun:test";

export const DEFAULT_TEST_TIMEOUT_MS = 30_000;
setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
