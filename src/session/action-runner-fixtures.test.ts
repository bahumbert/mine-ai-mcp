// The stub action the action-runner test files share.
import assert from "node:assert/strict";
import { z } from "zod";
import { defineAction, actionResultSchema, type Action, type ActionExecution } from "../actions/index.js";
import { ActionRunner } from "./action-runner.js";

export const stubInputSchema = z.object({ block_name: z.string().optional() });

export const stubResultSchema = actionResultSchema({});

export type StubResult = z.output<typeof stubResultSchema>;

export type StubAction = Action<"stub", { block_name: string }, StubResult>;

/** One stub action so the runner is tested without any physics. */
export function stubAction(
  execute: NonNullable<StubAction["execute"]>,
  execution: ActionExecution = { kind: "task" },
  movement: false | "travel" | "work" = false,
): StubAction {
  return defineAction({
    name: "stub",
    ...(movement && { movement }),
    description: "stub",
    inputSchema: stubInputSchema,
    resultSchema: stubResultSchema,
    formatResult: (result) => result.status,
    parse: (input: unknown) => {
      const request = stubInputSchema.parse(input);
      if (!request.block_name) throw new Error("block_name is required.");
      return { block_name: request.block_name };
    },
    ...(execution.kind === "resumable_task"
      ? {
          execution,
          begin: (request: { block_name: string }) => (context: Parameters<typeof execute>[1]) =>
            execute(request, context),
        }
      : { execution, execute }),
  });
}

/** Let the executor start: the runner prepares a task a microtask after `run` returns. */
export async function started(runs: { count: number }, count: number): Promise<void> {
  for (let turn = 0; turn < 50 && runs.count < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runs.count, count);
}

export async function untilOwner(runner: ActionRunner, owner: string): Promise<void> {
  for (let turn = 0; turn < 50 && runner.status().owner !== owner; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runner.status().owner, owner);
}
