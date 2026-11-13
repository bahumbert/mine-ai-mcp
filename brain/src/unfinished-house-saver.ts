// Saves the unfinished house as a note whenever it differs from the last one saved, one save after the other.
import type { UnfinishedHouse } from "./skills.ts";

/**
 * A save starts at once when none is running, so its call reaches the body before the caller's next one (a house
 * recorded as prepared must be on its way before the first part is built); one asked while another runs is made
 * after it, reading the house as it is then, so a quick run of changes is not saved twice. A house counts as saved
 * only when the note went through, so a save that failed (a body that is down fails every call, `note_save` too) is
 * asked again by the next {@link request}.
 */
export class UnfinishedHouseSaver {
  private saved = "null";
  private saving = false;
  private again = false;

  /** `save` resolves whether the note was saved and never rejects; `current` is the house now. */
  constructor(private readonly save: (house: UnfinishedHouse | null) => Promise<boolean>, private readonly current: () => UnfinishedHouse | null) {}

  /** The house a note already holds (what the brain recalled at start). */
  known(house: UnfinishedHouse | null): void {
    this.saved = JSON.stringify(house);
  }

  /** Saves the house if it changed since the last save that went through. */
  request(): void {
    if (this.saving) this.again = true;
    else void this.run();
  }

  private async run(): Promise<void> {
    this.saving = true;
    try {
      do {
        this.again = false;
        const house = this.current();
        const json = JSON.stringify(house);
        if (json !== this.saved && await this.save(house)) this.saved = json;
      } while (this.again);
    } finally {
      this.saving = false;
    }
  }
}
