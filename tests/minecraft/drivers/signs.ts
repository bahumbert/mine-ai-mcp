// Execute sign scenario steps and check their observed results.
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaActionInput } from "../arena/frame.ts";
import type { ScenarioContext, ScenarioCall } from "../scenario.ts";
import { waitServerTicks } from "./server-ticks.ts";

const inputSchema = z.record(z.string(), z.unknown());
const expectationSchema = z.strictObject({ status: z.enum(["succeeded", "failed", "partial"]), errorContains: z.string().optional() });
const expectedSchema = z.union([expectationSchema, z.strictObject({ anyOf: z.array(expectationSchema).min(1) })]);
const stepSchema = z.union([
  z.strictObject({ call: z.string(), input: inputSchema, expect: expectedSchema.optional(), save: z.string().optional() }),
  z.strictObject({ cancel: z.string(), input: inputSchema }),
  z.strictObject({ firstReady: z.string(), save: z.string() }),
  z.strictObject({ waitServerTicks: z.number().int().positive() }),
  z.strictObject({ check: z.literal("confirmed") }),
  z.strictObject({ check: z.literal("signPresent") }),
  z.strictObject({ check: z.literal("signAbsent") }),
  z.strictObject({ check: z.literal("signState"), frontAny: z.array(z.array(z.string())).min(1) }),
  z.strictObject({ check: z.literal("signLines"), at: inputSchema, front: z.array(z.string()), back: z.array(z.string()).optional() }),
]);
const stepsSchema = z.strictObject({ steps: z.array(stepSchema).min(1) });

/** Resolve saved result paths within an input, preserving literal values. */
function resolveSavedReferences(value: unknown, saved: Record<string, unknown>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    return value.slice(1).split(".").reduce<unknown>((current, key) =>
      current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, saved);
  }
  if (Array.isArray(value)) return value.map((item) => resolveSavedReferences(item, saved));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSavedReferences(item, saved)]));
  return value;
}

/** Cancel on the target packet, or after five server ticks; never credit an unsent cut. */
async function cancelSign(context: ScenarioContext, action: string, input: Record<string, unknown>): Promise<string | null> {
  const client = context.bot._client;
  const write = client.write;
  const x = Number(input.x), y = Number(input.y), z = Number(input.z);
  const faces: Record<string, [number, number, number]> = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
  const directions: Record<string, number> = { north: 2, south: 3, west: 4, east: 5 };
  const direction = input.fill_blank || input.attach === "wall" ? directions[String(input.facing)] : 1;
  const face = input.fill_blank ? [0, 0, 0] : input.attach === "wall" ? faces[String(input.facing)] ?? [0, 0, 0] : [0, 1, 0];
  const support = [x - face[0]!, y - face[1]!, z - face[2]!];
  let sent!: () => void;
  const packet = new Promise<"sent">((done) => { sent = () => done("sent"); });
  const stopWait = new AbortController();
  const fiveTicks = waitServerTicks(context.bot, 5, { signal: stopWait.signal })
    .then((outcome) => outcome === "stalled" ? "stalled" as const : "ticks" as const)
    .catch(() => "cancelled" as const);
  client.write = function (this: unknown, name: string, params: unknown) {
    const result = write.call(this, name, params);
    const packetData = params as { location?: { x: number; y: number; z: number }; direction?: number };
    const location = packetData.location;
    if (name === "block_place" && packetData.direction === direction && location?.x === support[0] && location.y === support[1] && location.z === support[2]) sent();
    return result;
  } as typeof client.write;
  try {
    const pending = context.call(action, input);
    const first = await Promise.race([packet, pending.then(() => "settled" as const), fiveTicks]);
    if (first === "settled" || first === "cancelled") return `Action ${first} before cancellation`;
    const cancel = await context.call("cancel_foreground_action", { reason: "scenario cancellation" });
    const stopped = await pending;
    if (first === "stalled") return "Server clock stalled before cancellation";
    if (first !== "sent") return "Cancellation occurred before the target packet";
    if (cancel.result.status !== "succeeded" || stopped.result.status !== "cancelled") return `Cancellation failed: ${cancel.summary}; ${stopped.summary}`;
    return null;
  } finally {
    client.write = write;
    stopWait.abort();
  }
}

/** Select the first family member for which the runtime reports a ready plan. */
async function firstReady(context: ScenarioContext, members: unknown): Promise<string | undefined> {
  if (!Array.isArray(members)) return undefined;
  for (const member of members) {
    if (typeof member !== "string") continue;
    const answer = await context.call("view_crafting_requirements", { items: [{ item_name: member, count: 1 }] });
    const result = answer.result as unknown as { requirements?: { plan?: { status?: string } } };
    if (answer.result.status === "succeeded" && result.requirements?.plan?.status === "ready") return member;
  }
  return undefined;
}

/** Run the declared calls and stop on the first unexpected result. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { steps } = stepsSchema.parse(context.scenario.params);
  const saved: Record<string, unknown> = {};
  let last: ScenarioCall | undefined;
  for (const step of steps) {
    if ("waitServerTicks" in step) {
      if (await waitServerTicks(context.bot, step.waitServerTicks) === "stalled") return { status: "failed", detail: "Server clock stalled" };
      continue;
    }
    if ("cancel" in step) {
      const input = arenaActionInput(resolveSavedReferences(step.input, saved) as Record<string, unknown>, context.arena);
      const error = await cancelSign(context, step.cancel, input);
      if (error) return { status: "failed", detail: error };
      continue;
    }
    if ("firstReady" in step) {
      const ready = await firstReady(context, resolveSavedReferences(step.firstReady, saved));
      if (!ready) return { status: "failed", detail: "No ready family member" };
      saved[step.save] = ready;
      continue;
    }
    if ("check" in step && step.check === "confirmed") {
      const result = last?.result as unknown as { sign?: { confirmed?: boolean } } | undefined;
      if (!result?.sign?.confirmed) return { status: "failed", detail: "Sign text was not confirmed" };
      continue;
    }
    if ("check" in step && step.check === "signPresent") {
      const result = last?.result as unknown as { signs?: { known: boolean }[] } | undefined;
      if (last?.result.status !== "succeeded" || result?.signs?.length !== 1 || !result.signs[0]?.known) return { status: "failed", detail: "No known sign after cancellation" };
      continue;
    }
    if ("check" in step && step.check === "signAbsent") {
      const result = last?.result as unknown as { signs?: unknown[] } | undefined;
      if (last?.result.status !== "succeeded" || result?.signs?.length !== 0) return { status: "failed", detail: "A sign remains at the cell" };
      continue;
    }
    if ("check" in step && step.check === "signState") {
      const result = last?.result as unknown as { signs?: { known: boolean; front: string[]; back: string[] }[] } | undefined;
      const sign = result?.signs?.[0];
      if (last?.result.status !== "succeeded" || result?.signs?.length !== 1 || !sign?.known || !step.frontAny.some((front) => JSON.stringify(front) === JSON.stringify(sign.front)) || JSON.stringify(sign.back) !== JSON.stringify(["", "", "", ""])) return { status: "failed", detail: "Unexpected sign state after cancellation" };
      continue;
    }
    if ("check" in step && step.check === "signLines") {
      const at = arenaActionInput(step.at, context.arena) as Record<string, unknown>;
      const read = await context.call("read_signs", at);
      const result = read.result as unknown as { status: string; signs?: { known: boolean; front: string[]; back: string[] }[] };
      const sign = result.signs?.[0];
      if (result.status !== "succeeded" || !sign?.known || JSON.stringify(sign.front) !== JSON.stringify(step.front) || (step.back !== undefined && JSON.stringify(sign.back) !== JSON.stringify(step.back))) return { status: "failed", detail: `Sign text mismatch: ${read.summary}` };
      continue;
    }
    if (!("call" in step)) return { status: "failed", detail: "Invalid sign step" };
    last = await context.call(step.call, arenaActionInput(resolveSavedReferences(step.input, saved) as Record<string, unknown>, context.arena));
    const expected = step.expect;
    const result = last.result;
    const choices = expected && "anyOf" in expected ? expected.anyOf : [expected ?? { status: "succeeded" as const }];
    const matches = choices.some((choice) => result.status === (choice.status ?? "succeeded") && (!choice.errorContains || ("error" in result && result.error.includes(choice.errorContains))));
    if (("kind" in result && result.kind === "runtime_failure") || !matches) return { status: "failed", detail: last.summary };
    if (typeof step.save === "string") saved[step.save] = result;
  }
  return { status: "succeeded", detail: "Sign steps completed" };
}
