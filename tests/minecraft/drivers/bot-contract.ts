/**
 * Runs one contract check (`params.check`, `tests/minecraft/contract/checks.ts`) on the real server. Unlike every other
 * driver, it acts on the Mineflayer bot directly and sends op commands as chat: it tests Mineflayer and the server, the
 * answers the shared fake bot must give, not our actions (`scenario.ts`: "every action goes through `call`"). A check
 * our runtime would disturb runs bare (`withoutRuntime`, `client-host.ts --without-runtime`).
 */
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { contractCheckNamed } from "../contract/checks.ts";
import { serverContractSubject } from "../contract/subject.ts";
import type { ScenarioContext } from "../scenario.ts";

const paramsSchema = z.strictObject({ check: z.string().min(1) });

export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const check = contractCheckNamed(paramsSchema.parse(context.scenario.params).check);
  try {
    await check.run(serverContractSubject(context.bot, context.arena));
  } catch (cause) {
    return { status: "failed", detail: `${check.name}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  return { status: "succeeded", detail: `${check.name} holds` };
}
