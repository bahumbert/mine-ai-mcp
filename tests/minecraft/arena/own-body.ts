/** A fresh player body for the next scenario on a reusable server of its own: only the players' names change, nothing moves. */
import type { GoalCondition, GoalSpec, Scenario } from "mine-labs";
import { LAST_BODY } from "./lanes.ts";
import { playerRenames, type Shifted } from "./shift-scenario.ts";
import { Refusal } from "./shift-walk.ts";

/** Lane 0 is the server of its own (offset zero); its bodies are named like a lane's. */
const OWN_SERVER_LANE = 0;

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/gu;

/** A name's place in a command: bounded by anything that cannot be part of another name. */
function wholeWord(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${name.replaceAll(REGEX_SPECIALS, "\\$&")}(?![A-Za-z0-9_])`, "gu");
}

/** `command` with each renamed player's name replaced where it stands as a whole word (never inside another name). */
function renameInCommand(command: string, renames: ReadonlyMap<string, string>): string {
  let renamed = command;
  for (const [from, to] of renames) renamed = renamed.replace(wholeWord(from), () => to);
  return renamed;
}

function renameGoal<G extends GoalSpec | GoalCondition>(goal: G, renames: ReadonlyMap<string, string>): G {
  const who = "who" in goal && goal.who !== undefined ? { who: renames.get(goal.who) ?? goal.who } : {};
  if ((goal.kind === "all" || goal.kind === "any") && "goals" in goal) {
    return { ...goal, ...who, goals: goal.goals.map(child => renameGoal(child, renames)) };
  }
  return { ...goal, ...who };
}

/**
 * The scenario with its players under the names of body `body` of a server of its own, or why that cannot be done. The
 * server keeps a player's data by name, so the second scenario on a reused server must not log in as the first did
 * (air, hotbar slot, fall distance...): the same reason a lane's trials take a body (`playerRenames`). Body 0, the first
 * scenario of a server, runs as written.
 */
export function renameBodyOnOwnServer(scenario: Scenario, body: number): Shifted {
  if (body === 0) return { ok: true, scenario };
  if (body > LAST_BODY) return { ok: false, reason: `body ${body} is past the last (${LAST_BODY}): a player name would come back` };
  try {
    const renames = playerRenames(scenario, OWN_SERVER_LANE, body);
    const commands = (list: readonly string[]): string[] => list.map(command => renameInCommand(command, renames));
    return {
      ok: true,
      scenario: {
        ...scenario,
        players: scenario.players.map(player => ({ ...player, name: renames.get(player.name)! })),
        geometry: scenario.geometry.map(step => ("run" in step ? { run: renameInCommand(step.run, renames) } : step)),
        reset: commands(scenario.reset),
        setup: commands(scenario.setup),
        tick: commands(scenario.tick),
        goal: renameGoal(scenario.goal, renames),
      },
    };
  } catch (cause) {
    if (cause instanceof Refusal) return { ok: false, reason: cause.message };
    throw cause;
  }
}
