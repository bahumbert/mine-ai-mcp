// Game facts the agent learns from the runtime and keeps for the session: block tags, foods seen, how items are got, the kind of work a step was.
import type { Step } from "../actions.ts";
import { activityOf, activityTimes, gatheringActivity, type Activity, type ActionTime, type ActivityPhase, type ActivitySpan } from "../activities.ts";
import type { MaterialCount } from "../building/blueprint.ts";
import { obtainedBy } from "../gathering/how-to-get.ts";
import type { Shortfall } from "../opportunities.ts";
import type { BlockKind, BotRuntime, BotSnapshot, Position } from "../runtime-client.ts";
import { carriedOf } from "./work.ts";

export class GameFacts {
  /** The game's data per block name, as the runtime reports it (null: no such block), read once. */
  private readonly blockKindCache = new Map<string, BlockKind | null>();
  readonly foods = new Set<string>();
  private readonly itemActivities = new Map<string, Activity | null>();

  constructor(private readonly runtime: BotRuntime, private readonly log: (line: string) => void) {}

  /**
   * The kind of work a finished step was, from game facts the runtime gives (block tags, hostile species, foods),
   * learnt once per name. Null for errands, or when the facts cannot be read (the step still happened).
   */
  async activityOf(step: Step, actions: readonly ActionTime[], before: BotSnapshot, started: number, ended: number, phases: readonly ActivityPhase[], after?: BotSnapshot | null): Promise<{ readonly activity: Activity | null; readonly spans: readonly ActivitySpan[]; readonly carried: string | null; readonly position: Position | null; readonly room: Pick<BotSnapshot, "inventory" | "foods"> | null }> {
    try {
      after ??= await this.runtime.status();
      for (const food of [...before.foods, ...after.foods]) this.foods.add(food.name);
      const hostile = new Set([...before.mobs, ...after.mobs].filter((mob) => mob.hostile).map((mob) => mob.name));
      const blocks = actions.flatMap((action) => action.tool === "collect_block" && typeof action.input.block_name === "string" ? [action.input.block_name] : []);
      if (step.skill === "collect_block") blocks.push(step.block);
      const facts = { tags: await this.tagsOf(blocks), hostile, foods: this.foods };
      const carried = carriedOf(after);
      return { activity: activityOf(step, actions, facts), spans: activityTimes(step, actions, facts, started, ended, phases), carried, position: after.position, room: { inventory: after.inventory, foods: after.foods } };
    } catch (error) {
      this.log(`could not tell what kind of work that was: ${String(error)}`);
      return { activity: null, spans: [], carried: null, position: null, room: null };
    }
  }

  /** The game's block tags of these blocks, asked of the runtime once per name. */
  async tagsOf(blocks: readonly string[]): Promise<Readonly<Record<string, readonly string[]>>> {
    const kinds = await this.kindsOf(blocks);
    return Object.fromEntries(blocks.map((block) => [block, kinds.get(block)?.tags ?? []]));
  }

  /** The game's data for these names (an item that is no block has none), asking the runtime only for names not yet known. */
  async kindsOf(names: readonly string[]): Promise<ReadonlyMap<string, BlockKind | null>> {
    const unknown = [...new Set(names)].filter((name) => !this.blockKindCache.has(name));
    if (unknown.length > 0) {
      const kinds = await this.runtime.blockKinds(unknown);
      for (const name of unknown) this.blockKindCache.set(name, kinds[name] ?? null);
    }
    return this.blockKindCache;
  }

  /** Each missing material with the work that gets it (as `get_items` would); the ones no work gets are left out. */
  async withActivities(items: readonly MaterialCount[]): Promise<Shortfall[]> {
    const missing: Shortfall[] = [];
    for (const { item, count } of items) {
      let activity = this.itemActivities.get(item);
      if (activity === undefined) {
        const how = await obtainedBy(this.runtime, item);
        activity = how.way === "gather"
          ? gatheringActivity(how.block, { tags: await this.tagsOf([how.block]), hostile: new Set(), foods: this.foods })
          : how.way === "craft" || how.way === "smelt" ? "crafting" : how.way === "farm" ? "farming" : how.way === "hunt" ? "hunting" : null;
        this.itemActivities.set(item, activity);
      }
      if (activity !== null) missing.push({ item, count, activity });
    }
    return missing;
  }
}
