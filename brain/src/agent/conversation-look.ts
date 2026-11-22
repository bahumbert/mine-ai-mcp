// The background look at the world that keeps conversations going: range and silence ends while in one, the opening gate otherwise.
import type { AgentOptions } from "../agent.ts";
import type { ConversationController } from "../conversation/controller.ts";
import { noteNoPosition } from "../conversation/state.ts";
import { elapsedSince, monotonicNow } from "../monotonic-clock.ts";
import type { TalkState } from "./chat-routing.ts";
import type { AgentMemory } from "./agent-memory.ts";
import type { Work } from "./work.ts";

/** A conversation reads the status every 2 s: its range (20 s) and silence (60 s) ends need no finer look. */
const TALK_LOOK_MS = 2_000;

/** What the look reads from the agent it belongs to. */
export interface ConversationLookHost {
  readonly options: AgentOptions;
  readonly talks: ConversationController | null;
  readonly state: TalkState;
  readonly memory: AgentMemory;
  readonly stack: readonly Work[];
  lastFailed(): { readonly objective: string; readonly reason: string } | null;
  activity(): string;
  runSignal(): AbortSignal;
}

export class ConversationLook {
  /** When conversations were last looked at, and whether that look is still running. */
  private checkedAt = -Infinity;
  /** The conversation (its id, null for none) the last look was made for: a different one is looked at on the next pass. */
  private lookedAt: string | null = null;
  private looking = false;
  /** The conversation check could not read the runtime: logged once, again only after a read worked. */
  private unreadable = false;

  constructor(private readonly host: ConversationLookHost) {}

  /**
   * Looks after the conversation in the background, so a slow opening call never holds up reading the chat: range and
   * silence ends while in one, else the code gate of an opening every check interval.
   */
  lookAtConversations(): void {
    const { talks, options } = this.host;
    if (talks === null || this.looking || this.host.runSignal().aborted) return;
    const talkId = talks.current?.id ?? null;
    const every = talkId === null ? options.persona.settings.conversation.checkEverySeconds * 1_000 : options.talkLookMs ?? TALK_LOOK_MS;
    if (talkId === this.lookedAt && elapsedSince(this.checkedAt) < every) return;
    this.checkedAt = monotonicNow();
    this.lookedAt = talkId;
    this.looking = true;
    void this.look(talks)
      .catch((error: unknown) => {
        if (!this.unreadable) options.log(`conversation check failed (not logged again until a read works): ${String(error)}`);
        this.unreadable = true;
      })
      .finally(() => { this.looking = false; });
  }

  private async look(talks: ConversationController): Promise<void> {
    const { options, state } = this.host;
    const signal = this.host.runSignal();
    const snapshot = await options.runtime.status();
    this.unreadable = false;
    state.onlineNames = snapshot.players.map((player) => player.username);
    noteNoPosition(state.noPositionSince, snapshot.players, monotonicNow());
    state.lastLook = snapshot;
    await talks.tick(snapshot, signal);
    // An order, an event on the stack (a night, a respawn) or a socialising objective on its way (it opens its own conversation) is busy enough.
    const top = this.host.stack.at(-1);
    const busy = (top?.objective.requester ?? null) !== null || top?.situation != null || top?.objective.purpose === "socialising" || top?.objective.purpose === "trading";
    await talks.maybeOpen({ snapshot, activity: this.host.activity(), lately: this.host.memory.lately, lastFailed: this.host.lastFailed(), busy }, signal);
  }
}
