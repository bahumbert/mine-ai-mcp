// Reads shared freeze markers and decides when a stall needs its first record.
import { freezeViews, MARKER_BYTES, MARKER_SLOTS, REPEATS_INDEX, SLOT_BYTES } from "./freeze-watch.js";

const decoder = new TextDecoder();

/** Read the newest published markers oldest first, translating their main-thread clock stamps for the record. */
export function readMarkers(views: ReturnType<typeof freezeViews>, wallTimeOf: (stampedAtMs: number) => string) {
  const end = Atomics.load(views.head, 0);
  const found: { sequence: number; at: string; text: string; repeats: number }[] = [];
  for (let sequence = Math.max(0, end - MARKER_SLOTS); sequence < end; sequence++) {
    const slot = sequence % MARKER_SLOTS;
    if (Atomics.load(views.slots, slot * (SLOT_BYTES / 4)) !== sequence + 1) continue;
    const length = Math.min(views.slots[slot * (SLOT_BYTES / 4) + 1]!, MARKER_BYTES);
    const base = slot * SLOT_BYTES + 16;
    found.push({
      sequence,
      at: wallTimeOf(views.times[slot * (SLOT_BYTES / 8) + 1]!),
      text: decoder.decode(views.text.subarray(base, base + length)),
      repeats: views.slots[slot * (SLOT_BYTES / 4) + REPEATS_INDEX]!,
    });
  }
  return found;
}

/** Record once per stall, rearming only after a reading below the threshold. */
export function createFreezeCheck(stallMs: number): (stalledMs: number) => boolean {
  let recorded = false;
  return (stalledMs) => {
    if (stalledMs < stallMs) {
      recorded = false;
      return false;
    }
    if (recorded) return false;
    recorded = true;
    return true;
  };
}
