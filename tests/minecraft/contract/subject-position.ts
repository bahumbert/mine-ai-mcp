// Authoritative block, body position and air probes used by the contract subjects.
import { Vec3 } from "vec3";
import type { FakeCell, FakeHarness } from "../../../src/test-support/fake-bot/index.ts";
import { SERVER_ANSWER_TICKS, SERVER_CLOCK_STOPPED_MS } from "../../../src/world/world-age.ts";
import { createMeasureReader, waitForCommandReply } from "./checks/combat-data-measure.ts";
import type { ContractSubject } from "./subject.ts";

type BodyPosition = Pick<ContractSubject, "teleportFeet" | "readBodyOnServer" | "holdBodyStill">;
type BlockActions = Pick<ContractSubject, "setBlock" | "blockIs">;
type SubjectBot = ContractSubject["bot"];
type SubjectClock = Pick<ContractSubject, "now" | "wait">;
type AfterAnswer = <T>(run: () => T, what: string) => Promise<T>;
const POSITION_SCALE = 1_000;
export const SERVER_FEET_TOLERANCE = 0.002;
export const CONTRACT_STORAGE = "mine_ai:contract";
export const SERVER_EDIT_WALL_MS = 3_000;

/** Wait for an answer to a body probe within the shared observed-age and stall bounds. */
export function waitForBodyReply(bot: SubjectBot, clock: SubjectClock | undefined, arrived: () => boolean): Promise<void> {
  return waitForCommandReply(bot, arrived, {
    observedTicks: SERVER_ANSWER_TICKS, stallMs: SERVER_CLOCK_STOPPED_MS, now: clock?.now, sleep: clock?.wait,
  });
}

/** Arm before the teleport so a synchronous forced move can answer it too. */
async function teleportTo(bot: SubjectBot, clock: SubjectClock, position: Vec3, send: () => void,
  checkBody?: () => void): Promise<void> {
  let arrived = false;
  const onMove = () => { arrived ||= bot.entity.position.equals(position); };
  bot.on("forcedMove", onMove);
  try {
    send();
    await waitForBodyReply(bot, clock, () => {
      checkBody?.();
      return arrived;
    });
  } finally {
    bot.off("forcedMove", onMove);
  }
}

/** Suspend local motion without changing the server's pose or air. */
function holdMotion(bot: ContractSubject["bot"]): Disposable {
  const enabled = bot.physicsEnabled;
  bot.physicsEnabled = false;
  return { [Symbol.dispose]: () => { bot.physicsEnabled = enabled; } };
}

/** Vanilla places the body with `/tp` and exposes the resulting air and feet through player NBT. */
export function serverBodyPosition(bot: ContractSubject["bot"], clock: SubjectClock): BodyPosition {
  const reader = createMeasureReader({ bot });
  const commands = ["run data get entity @s Air", ...[0, 1, 2].map((axis) => `run data get entity @s Pos[${axis}] ${POSITION_SCALE}`)];
  return {
    holdBodyStill: () => holdMotion(bot),
    teleportFeet: (position) => teleportTo(bot, clock, position, () => bot.chat(`/tp @s ${position.x} ${position.y} ${position.z}`)),
    async readBodyOnServer() {
      const readings = await reader.read(commands);
      if (readings.some(({ present, raw }) => !present || !Number.isInteger(raw))) throw new Error("body probe: missing or invalid Air or Pos in the server reply");
      const [air, x, y, z] = readings.map(({ raw }) => raw) as [number, number, number, number];
      return { feet: new Vec3(x / POSITION_SCALE, y / POSITION_SCALE, z / POSITION_SCALE), air };
    },
  };
}

/** Read through one fake server answer, discarding queued work after the wait or body ends. */
async function readFakeAnswer<T>({ bot, server }: FakeHarness, clock: SubjectClock, read: () => T, isCurrent?: () => boolean): Promise<T> {
  let active = true;
  let answer: { value: T } | undefined;
  server.answer(() => { if (active && isCurrent?.() !== false) answer = { value: read() }; });
  try {
    await waitForBodyReply(bot, clock, () => {
      if (isCurrent?.() === false) throw new Error("body probe: fixed body changed before the server answered");
      return answer !== undefined;
    });
    return answer!.value;
  } finally {
    active = false;
  }
}

/** The same teleport packet and a separate read of the fake server's body store. */
export function fakeBodyPosition(harness: FakeHarness, clock: SubjectClock): BodyPosition {
  const { bot, breath, server } = harness;
  type Scope = Disposable & { readonly entity: SubjectBot["entity"]; feet?: Disposable };
  let fixedBody: Scope | undefined;
  const current = (scope: Scope) => fixedBody === scope && bot.entity === scope.entity;
  const requireCurrent = (scope: Scope) => {
    if (!current(scope)) throw new Error("body probe: fixed body changed before the server answered");
  };
  return {
    holdBodyStill() {
      if (fixedBody !== undefined) throw new Error("body probe: a fixed body is already held");
      const motion = holdMotion(bot);
      const release = () => {
        if (fixedBody !== scope) return;
        fixedBody = undefined;
        bot.off("respawn", release);
        scope.feet?.[Symbol.dispose]();
        motion[Symbol.dispose]();
      };
      const scope: Scope = { entity: bot.entity, [Symbol.dispose]: release };
      fixedBody = scope;
      bot.once("respawn", release);
      return scope;
    },
    async teleportFeet(position) {
      const scope = fixedBody;
      if (!scope) throw new Error("body probe: teleport requires a fixed body");
      requireCurrent(scope);
      let pending = true;
      try {
        await teleportTo(bot, clock, position, () => server.answer(() => {
          if (!pending || !current(scope)) return;
          server.setServerPosition(scope.entity.id, position);
          scope.feet ??= breath.followServerFeet();
          server.sendPosition(position);
        }), () => requireCurrent(scope));
      } catch (error) {
        scope[Symbol.dispose]();
        throw error;
      } finally {
        pending = false;
      }
    },
    async readBodyOnServer() {
      const scope = fixedBody;
      if (!scope?.feet || !current(scope)) throw new Error("body probe: no controlled server feet for the current body");
      const body = await readFakeAnswer(harness, clock, () => ({
        feet: server.serverPositionOf(scope.entity.id)?.clone(),
        air: breath.airSupply,
      }), () => current(scope));
      if (!body.feet) throw new Error("body probe: no server feet for the current body");
      return { feet: body.feet, air: body.air };
    },
  };
}

/** A block as the `setblock` command writes it: `name[key=value,...]`. */
export function blockArgument(block: FakeCell): string {
  if (typeof block === "number") throw new Error(`a state id (${block}) has no command form: name the block`);
  if (typeof block === "string") return block;
  const properties = Object.entries(block.properties).map(([key, value]) => `${key}=${value}`);
  return `${block.name}[${properties.join(",")}]`;
}

export function fakeBlockActions(harness: FakeHarness, clock: SubjectClock, afterAnswer: AfterAnswer): BlockActions {
  const { world } = harness;
  return {
    setBlock: (cell, block) => afterAnswer(() => world.setCell(cell, block), "setBlock"),
    blockIs(cell, block, properties) {
      // Air/fire name-only checks keep the edit wait. The fixed-position source probe is server-paced.
      if (properties === undefined) return afterAnswer(() => world.blockAt(cell)?.name === block, "blockIs");
      return readFakeAnswer(harness, clock, () => {
        const observed = world.blockAt(cell);
        return observed?.name === block && Object.entries(properties).every(([key, value]) =>
          String(observed.getProperties()[key]) === String(value));
      });
    },
  };
}

let blockQuerySequence = 0;

/** Correlate a one-shot server block query, so a late reply cannot answer another question. */
async function queryServerBlock(bot: SubjectBot, cell: Vec3, block: string, serverPaced: boolean): Promise<boolean> {
  const key = `block_${bot.username}_${++blockQuerySequence}`;
  const prefix = `contract-${key} `;
  let answer: boolean | undefined;
  let received: (() => void) | undefined;
  const onMessage = (text: string) => {
    if (answer !== undefined || (text !== `${prefix}0` && text !== `${prefix}1`)) return;
    answer = text === `${prefix}1`;
    received?.();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const legacyWait = serverPaced ? undefined : new Promise<void>((resolve, reject) => {
    received = resolve;
    timer = setTimeout(() => reject(new Error(`/block query: no answer after ${SERVER_EDIT_WALL_MS} ms (is the bot op? or the server stalled)`)),
      SERVER_EDIT_WALL_MS);
  });
  bot.on("messagestr", onMessage as never);
  try {
    bot.chat(`/execute store success storage ${CONTRACT_STORAGE} ${key} int 1 run execute if block ${cell.x} ${cell.y} ${cell.z} ${block}`);
    bot.chat(`/tellraw @s {"text":"${prefix}","extra":[{"nbt":"${key}","storage":"${CONTRACT_STORAGE}"}]}`);
    await (legacyWait ?? waitForBodyReply(bot, undefined, () => answer !== undefined));
    return answer!;
  } finally {
    clearTimeout(timer);
    bot.off("messagestr", onMessage as never);
  }
}

export function serverBlockActions(bot: SubjectBot,
  commandUntil: (command: string, cell: Vec3, name: string) => Promise<void>): BlockActions {
  return {
    blockIs: (cell, block, properties) => properties === undefined ? queryServerBlock(bot, cell, block, false)
      : queryServerBlock(bot, cell, blockArgument({ name: block, properties }), true),
    setBlock: (cell, block) => commandUntil(`setblock ${cell.x} ${cell.y} ${cell.z} ${blockArgument(block)}`, cell,
      typeof block === "string" ? block : typeof block === "number" ? "" : block.name),
  };
}
