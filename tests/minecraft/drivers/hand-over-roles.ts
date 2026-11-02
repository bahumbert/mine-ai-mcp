import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ArenaFrame } from "../arena/frame.ts";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";

/** The two roles of a hand-over scenario, as places in its `players` list (a lane renames the players, so a name written in the YAML would not match). */
export const handOverRolesSchema = {
  giver: z.number().int().nonnegative(),
  receiver: z.number().int().nonnegative(),
};

export interface HandOverRoles {
  /** The giver's and the receiver's names in this run (a lane's names when the scenario runs in a lane). */
  readonly giver: string;
  readonly receiver: string;
  readonly isGiver: boolean;
}

export function handOverRolesOf(context: ScenarioContext, places: { readonly giver: number; readonly receiver: number }): HandOverRoles {
  if (context.username === undefined) throw new Error("The client host gave this driver no username.");
  const { players } = context.scenario;
  const giver = players[places.giver]?.name;
  const receiver = players[places.receiver]?.name;
  if (giver === undefined || receiver === undefined) throw new Error(`params name players ${places.giver} and ${places.receiver}, but the scenario declares ${players.length}`);
  return { giver, receiver, isGiver: context.username === giver };
}

/** The `run` of a hand-over driver: the params of its scenario, then the giver's part or the other player's. */
export function handOverRun<Params extends { readonly giver: number; readonly receiver: number }>(
  paramsIn: (arena: ArenaFrame) => { parse(input: unknown): Params },
  give: (context: ScenarioContext, params: Params, roles: HandOverRoles) => Promise<ClientCompletion>,
  other: (context: ScenarioContext, params: Params) => Promise<ClientCompletion>,
): ScenarioRun {
  return async (context) => {
    const params = paramsIn(context.arena).parse(context.scenario.params);
    const roles = handOverRolesOf(context, params);
    return roles.isGiver ? give(context, params, roles) : other(context, params);
  };
}
