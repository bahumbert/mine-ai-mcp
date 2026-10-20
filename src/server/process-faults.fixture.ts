/**
 * Child process of `process-faults.test.ts`: installs the unhandled-rejection reporter, rejects as its mode says and
 * prints every report as `FAULT <json>`, then `alive` if it is still running. Bun reports an unhandled rejection late
 * and `bun test` can miss it, so the verdict is the child's own output and exit code.
 */
import { reportUnhandledRejections } from "./process-faults.js";

const [mode, repeatMs] = process.argv.slice(2);
const reporter = reportUnhandledRejections(
  (fault) => console.log(`FAULT ${JSON.stringify(fault)}`),
  { repeatReportMs: Number(repeatMs ?? 60_000) },
);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reject = (reason: unknown) => void Promise.reject(reason);

if (mode === "single") reject(new Error("boom"));
if (mode === "storm" || mode === "storm-later") for (let i = 0; i < 100; i++) reject(new Error("same fault"));
if (mode === "distinct") {
  reject(new Error("first fault"));
  reject(new Error("second fault"));
}
if (mode === "plain-string") reject("plain reason");
if (mode === "many") for (let i = 0; i < 150; i++) reject(new Error(`fault ${i}`));

await wait(200);
if (mode === "storm-later") {
  await wait(Number(repeatMs));
  reject(new Error("same fault"));
  await wait(200);
}
if (mode === "many") reject(new Error("fault 0")); // evicted by then: its first sighting is forgotten
await wait(200);
console.log("alive");
reporter[Symbol.dispose]();
