/** Moves a whole Mine Labs scenario into a lane of a shared server, or says why it must run on a server of its own. */
import { compileScenario, type GoalCondition, type GoalSpec, type Scenario } from "mine-labs";
import { ARENA_ENV, encodeArena, type ArenaOffset } from "./frame.ts";
import { BODY_DIGITS, type Lane } from "./lanes.ts";
import { shiftCommand, shiftPositionText, type CommandContext } from "./shift-command.ts";
import { POSITION_IN_DATA } from "./shift-selector.ts";
import { Refusal, refuseOutsideCell } from "./shift-walk.ts";

export type { Lane, LaneCell } from "./lanes.ts";

/** A scenario tagged this measures time or ticks, or changes a server-wide setting while it runs: it never shares a server. */
export const EXCLUSIVE_TAG = "exclusive";

export type Shifted = { readonly ok: true; readonly scenario: Scenario } | { readonly ok: false; readonly reason: string };

/**
 * Chunks vanilla holds with `forceload add`. Mine Labs keeps this constant private (`scenario/compile.ts`); the test
 * "the force-load limit is Mine Labs' own" holds it to `canResetScenario`.
 */
const FORCELOAD_CHUNK_LIMIT = 256;

/** The longest player name Minecraft accepts. */
const MAX_NAME_LENGTH = 16;

/** Goals that count entities across the whole server, where another lane's entities would count too. */
const SERVER_WIDE_GOALS: ReadonlySet<string> = new Set(["kill", "entityCount", "entityDistance"]);

type Position = Scenario["entities"][number]["pos"];
type Geometry = Scenario["geometry"][number];

/** Everything one shift needs: the lane, the player renames, and the command contexts. */
interface LaneWalk {
  readonly offset: ArenaOffset;
  readonly rcon: CommandContext;
  readonly tick: CommandContext;
}

/** The scenario placed in the lane (positions, commands, player names, `client.env`), or the reason it cannot share a server. */
export function shiftScenario(scenario: Scenario, lane: Lane): Shifted {
  try {
    return { ok: true, scenario: shiftInLane(scenario, lane) };
  } catch (cause) {
    if (cause instanceof Refusal) return { ok: false, reason: cause.message };
    throw cause;
  }
}

function shiftInLane(scenario: Scenario, lane: Lane): Scenario {
  refuseWhatIsServerWide(scenario);
  const renames = renamesOf(scenario, lane);
  const walk: LaneWalk = {
    offset: lane.offset,
    rcon: { where: "rcon", cell: lane.cell, renames },
    tick: { where: "tick", cell: lane.cell, renames },
  };
  const { spectator: _headless, ...rest } = scenario;
  const shifted: Scenario = {
    ...rest,
    players: scenario.players.map((player, index) => ({
      ...player,
      name: renames.get(player.name)!,
      pos: player.pos === undefined ? undefined : shiftPosition(player.pos, `players[${index}].pos`, walk),
    })),
    entities: scenario.entities.map((entity, index) => shiftEntity(entity, index, walk)),
    geometry: scenario.geometry.map((step, index) => shiftGeometry(step, index, walk)),
    reset: shiftCommands("reset", scenario.reset, walk.rcon, walk.offset),
    setup: shiftCommands("setup", scenario.setup, walk.rcon, walk.offset),
    tick: shiftCommands("tick", scenario.tick, walk.tick, walk.offset),
    goal: shiftGoal(scenario.goal, "goal", walk, renames),
    client: { ...scenario.client, env: { ...scenario.client.env, [ARENA_ENV]: encodeArena(lane.offset) } },
  };
  refuseArenaOutsideLane(shifted, lane);
  return shifted;
}

/** What no lane can share, whatever the commands say. */
function refuseWhatIsServerWide(scenario: Scenario): void {
  if (scenario.world.type !== "flat") throw new Refusal(`world.type is '${scenario.world.type}': only flat worlds share a server (natural terrain sits at fixed places)`);
  if (scenario.world.dimension !== "overworld") throw new Refusal(`world.dimension is '${scenario.world.dimension}': lanes are in the overworld`);
  if (scenario.world.spawn !== undefined) throw new Refusal("world.spawn sets the spawn of the whole server");
  if (scenario.verification !== undefined) throw new Refusal("verification travels the shared world around its spawn, outside any lane");
  if (scenario.tags.includes(EXCLUSIVE_TAG)) throw new Refusal("tagged 'exclusive': it measures time or ticks, or changes a server-wide setting while it runs, and must not share the server");
  scenario.players.forEach((player, index) => {
    if (player.pos === undefined) throw new Refusal(`players[${index}].pos is missing: a lane player would join at the world spawn, in no lane`);
  });
}

/**
 * Scenario player name -> lane name (`<name>L<lane><body>`, the name cut so the whole fits 16 characters). The body is
 * part of the name because the server keeps a player's data by name: each trial of a lane logs in as a player the
 * server has never seen, so nothing a predecessor left on its body (air, hotbar slot, fall distance) reaches it. The
 * suffix length does not depend on the body, so every body of a lane cuts a name at the same place and a clash is
 * refused for all of them.
 */
function renamesOf(scenario: Scenario, lane: Lane): Map<string, string> {
  const suffix = `L${lane.index}${lane.body.toString(36).padStart(BODY_DIGITS, "0")}`;
  const renames = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const { name } of scenario.players) {
    const renamed = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
    const clash = owners.get(renamed);
    if (clash !== undefined) throw new Refusal(`players '${clash}' and '${name}' are both '${renamed}' in lane ${lane.index}`);
    owners.set(renamed, name);
    renames.set(name, renamed);
  }
  return renames;
}

/** A position moved by the lane offset; one that lands outside the lane's cell would put the scenario in another lane. */
function placedInLane([x, y, z]: readonly [number, number, number], field: string, walk: LaneWalk): [number, number, number] {
  const placed: [number, number, number] = [x + walk.offset.x, y, z + walk.offset.z];
  refuseOutsideCell(placed[0], "x", walk.rcon.cell, field);
  refuseOutsideCell(placed[2], "z", walk.rcon.cell, field);
  return placed;
}

function shiftPosition(position: Position, field: string, walk: LaneWalk): Exclude<Position, string> | string {
  if (Array.isArray(position)) return placedInLane(position, field, walk);
  const shifted = shiftPositionText(position, walk.offset, walk.rcon);
  if (!shifted.ok) throw new Refusal(`${field}: '${position}': ${shifted.reason}`);
  return shifted.command;
}

function shiftCommands(field: string, commands: readonly string[], context: CommandContext, offset: ArenaOffset): string[] {
  return commands.map((command, index) => shiftCommandIn(`${field}[${index}]`, command, context, offset));
}

function shiftCommandIn(field: string, command: string, context: CommandContext, offset: ArenaOffset): string {
  const shifted = shiftCommand(command, offset, context);
  if (!shifted.ok) throw new Refusal(`${field}: '${command}': ${shifted.reason}`);
  return shifted.command;
}

function shiftEntity(entity: Scenario["entities"][number], index: number, walk: LaneWalk): Scenario["entities"][number] {
  if (entity.nbt !== undefined && POSITION_IN_DATA.test(entity.nbt)) throw new Refusal(`entities[${index}].nbt holds a position, which the lane shift does not move: '${entity.nbt}'`);
  return { ...entity, pos: shiftPosition(entity.pos, `entities[${index}].pos`, walk) };
}

function shiftGeometry(step: Geometry, index: number, walk: LaneWalk): Geometry {
  const field = `geometry[${index}]`;
  if ("fill" in step) {
    const { from, to } = step.fill;
    return { fill: { ...step.fill, from: shiftPosition(from, `${field}.fill.from`, walk), to: shiftPosition(to, `${field}.fill.to`, walk) } };
  }
  if ("setblock" in step) return { setblock: { ...step.setblock, at: shiftPosition(step.setblock.at, `${field}.setblock.at`, walk) } };
  return { run: shiftCommandIn(`${field}.run`, step.run, walk.rcon, walk.offset) };
}

/** A goal tree with its positions moved and its `who` renamed; goals that count the whole server are refused. */
function shiftGoal<G extends GoalSpec | GoalCondition>(goal: G, field: string, walk: LaneWalk, renames: ReadonlyMap<string, string>): G {
  if (SERVER_WIDE_GOALS.has(goal.kind)) throw new Refusal(`${field}: a '${goal.kind}' goal counts entities across the whole server, other lanes' included`);
  const who = "who" in goal && goal.who !== undefined ? { who: renames.get(goal.who) ?? goal.who } : {};
  const moved = (x: number, y: number, z: number): [number, number, number] => placedInLane([x, y, z], field, walk);
  switch (goal.kind) {
    case "reach":
      return { ...goal, ...who, pos: moved(...goal.pos) };
    case "blockAt":
      return { ...goal, ...who, pos: moved(...goal.pos) };
    case "blocksAt":
      return { ...goal, ...who, positions: goal.positions.map((position) => moved(...position)) };
    case "all":
    case "any":
      return { ...goal, goals: goal.goals.map((child, index) => shiftGoal(child, `${field}.goals[${index}]`, walk, renames)) };
    default:
      return { ...goal, ...who };
  }
}

/** The pinned arena and its scratch copy must lie inside the lane's cell and within what Minecraft force-loads. */
function refuseArenaOutsideLane(shifted: Scenario, lane: Lane): void {
  const { snapshot } = compileScenario(shifted);
  if (snapshot === null) return;
  const { cell } = lane;
  for (const region of snapshot.pin) {
    if (region.minX < cell.minX || region.maxX > cell.maxX || region.minZ < cell.minZ || region.maxZ > cell.maxZ) {
      throw new Refusal(`arena wider than a lane: x ${region.minX}..${region.maxX}, z ${region.minZ}..${region.maxZ} (with its scratch copy) leaves lane ${lane.index}'s cell x ${cell.minX}..${cell.maxX}, z ${cell.minZ}..${cell.maxZ}`);
    }
  }
  const chunks = snapshot.pin.reduce((sum, region) => sum + region.chunks, 0);
  if (chunks > FORCELOAD_CHUNK_LIMIT) throw new Refusal(`the arena pins ${chunks} chunks with its scratch copy, above the ${FORCELOAD_CHUNK_LIMIT} Minecraft force-loads`);
}
