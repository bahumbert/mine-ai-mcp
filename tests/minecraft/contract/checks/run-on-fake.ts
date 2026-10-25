/** A contract check run on the shared fake bot with the server set up as a test needs: the one place the tests of a check's edge cases build their harness, stalls and faults. */
import type { FakeServerOptions } from "../../../../src/test-support/fake-bot/index.ts";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import type { ContractCheck } from "../checks.ts";
import { fakeHarnessFor } from "../fake-harness.ts";
import { type ContractSubject, fakeContractSubject } from "../subject.ts";

export type FakeHarness = ReturnType<typeof fakeHarnessFor>;

/** The server stops for `ms` of clock from `atMs` of clock after the run starts, then resumes (the game catches the ticks up or drops them as `FakeServer` says). */
export interface ServerStall {
  readonly atMs: number;
  readonly ms: number;
}

/** Run `check` on the fake; `change` rewrites the subject before the check runs (a fault to inject), `stalls` stop the server. */
export function runOnFake(
  check: ContractCheck,
  server: FakeServerOptions = {},
  change: (subject: ContractSubject, harness: FakeHarness) => ContractSubject = (subject) => subject,
  stalls: readonly ServerStall[] = [],
): Promise<void> {
  const frame = arenaFrame(ZERO_ARENA);
  const harness = fakeHarnessFor(check.fixture, frame, server);
  const installed = harness.clock.install();
  for (const { atMs, ms } of stalls) {
    harness.clock.after(atMs, () => harness.server.stop());
    harness.clock.after(atMs + ms, () => harness.server.resume());
  }
  return check.run(change(fakeContractSubject(harness, frame), harness)).finally(() => installed[Symbol.dispose]());
}

/** A subject whose `serverGameTime` answers the server's tick plus `shift(readIndex)` (the first read is index 0; the shift is decided when the question is asked, not when it is answered): a server that told the check a tick it was not at. */
export function withShiftedReads(subject: ContractSubject, shift: (readIndex: number) => number): ContractSubject {
  let reads = 0;
  return {
    ...subject,
    serverGameTime: async () => {
      const shiftAtAsk = shift(reads++);
      return (await subject.serverGameTime()) + shiftAtAsk;
    },
  };
}

/** A subject whose client reads the age `extra` ticks further ahead with each time packet it has heard: a server whose regular packets step `extra` ticks more than 20. */
export function withSteppingAges(subject: ContractSubject, extra: number): ContractSubject {
  let drift = 0;
  subject.bot.on("time", () => void (drift += extra));
  const bot = new Proxy(subject.bot, {
    get: (target, property) => (property === "time" ? { ...target.time, age: target.time.age + drift } : Reflect.get(target, property, target)),
  });
  return { ...subject, bot };
}
