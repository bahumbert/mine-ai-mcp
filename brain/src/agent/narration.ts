// Order progress and outcome narration, kept separate from the work loop.
import type { AgentOptions } from "../agent.ts";
import type { ChatLine, NarrateInput } from "../mind.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { Work } from "./work.ts";

interface NarrationHost {
  readonly options: AgentOptions;
  readonly stack: readonly Work[];
  readonly history: readonly ChatLine[];
  runSignal(): AbortSignal;
  speak(line: string, whisperTo: string | null): void;
}

export class AgentNarration {
  constructor(private readonly host: NarrationHost) {}

  /** Progress from a stopped order is silent; repeated facts and frequent updates never ask the model again. */
  progress(work: Work, fact: string): void {
    const { options, stack } = this.host;
    if (!stack.includes(work) || fact === work.lastFact) return;
    work.lastFact = fact;
    options.log(`  now: ${fact}`);
    const asked = monotonicNow() - work.spokenAt >= options.persona.settings.narrateEverySeconds * 1_000;
    options.journal?.({ kind: "progress", objective: work.objective.text, fact, asked });
    if (!asked) return;
    work.spokenAt = monotonicNow();
    void this.narrate(work.objective.text, "progress", fact, work.whisperTo, () => stack.includes(work));
  }

  /** A late progress line is dropped if its order stopped while the chat tier thought (BRN-11). */
  async narrate(objective: string, outcome: NarrateInput["outcome"], detail: string, whisperTo: string | null, stillOn: () => boolean = () => true): Promise<void> {
    if (this.host.runSignal().aborted) return;
    const { options, history } = this.host;
    try {
      const line = await options.mind.narrate({ persona: options.persona, objective, outcome, detail, history }, this.host.runSignal());
      if (stillOn()) this.host.speak(line, whisperTo);
    } catch (error) {
      options.log(`narration failed: ${String(error)}`);
    }
  }
}
