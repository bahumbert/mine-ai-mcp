// Reads hostile interruptions and keeps their per-agent history across gatherings.
interface HostileContact {
  readonly response: string;
  readonly mobs: { readonly name: string; readonly id: number; readonly cell: string }[];
}

interface Interruption {
  readonly name: string;
  readonly id: number;
  readonly cell: string;
  readonly count: number;
  readonly firstAt: number;
  readonly moved: boolean;
}

/** Repeated interruptions by the same threat end gathering so the model can choose again. */
export const SAME_HOSTILE_LIMIT = 3;
const INTERRUPTION_EXPIRY_MS = 10 * 60_000;

interface MeasuredContact extends HostileContact {
  readonly mobs: (HostileContact["mobs"][number] & { readonly distance: number })[];
}

/** Reads only the threat list, stopping before any trailing, possibly nested reason. */
function measuredHostileContact(detail: string): MeasuredContact | null {
  const header = /^\[HOSTILE_CONTACT\] (\S+) response for /u.exec(detail);
  if (header === null) return null;
  const threat = /([^\s,#]+)#(\d+) at (-?\d+,-?\d+,-?\d+) \((\d+(?:\.\d+)?) blocks\)/uy;
  threat.lastIndex = header[0].length;
  const mobs: MeasuredContact["mobs"] = [];
  for (let match = threat.exec(detail); match !== null; match = threat.exec(detail)) {
    mobs.push({ name: match[1]!, id: Number(match[2]), cell: match[3]!, distance: Number(match[4]) });
    if (detail.slice(threat.lastIndex, threat.lastIndex + 2) !== ", ") break;
    threat.lastIndex += 2;
  }
  return mobs.length === 0 ? null : { response: header[1]!, mobs };
}

/** Reads the runtime's documented hostile-contact format. */
export function parseHostileContact(detail: string): HostileContact | null {
  const contact = measuredHostileContact(detail);
  return contact === null ? null : {
    response: contact.response,
    mobs: contact.mobs.map(({ name, id, cell }) => ({ name, id, cell })),
  };
}

/** Keeps interruptions by mob id for one agent, across its gathering calls. */
export class HostileInterruptions {
  private readonly interruptions = new Map<number, { readonly interruption: Interruption; readonly distance: number; readonly lastAt: number }>();

  constructor(private readonly now: () => number) {}

  /** Notes each listed threat and returns the one that interrupted most often. */
  note(detail: string): Interruption | null {
    const now = this.now();
    for (const [id, previous] of this.interruptions) {
      if (now - previous.lastAt >= INTERRUPTION_EXPIRY_MS) this.interruptions.delete(id);
    }
    const contact = measuredHostileContact(detail);
    if (contact === null) return null;
    let most: Interruption | null = null;
    for (const mob of new Map(contact.mobs.map((mob) => [mob.id, mob])).values()) {
      const previous = this.interruptions.get(mob.id);
      const changedCell = previous !== undefined && previous.interruption.cell !== mob.cell;
      const walkedOff = changedCell && mob.distance > previous.distance;
      const earlier = walkedOff ? undefined : previous?.interruption;
      const interruption: Interruption = {
        name: mob.name, id: mob.id, cell: mob.cell,
        count: (earlier?.count ?? 0) + 1,
        firstAt: earlier?.firstAt ?? now,
        moved: earlier !== undefined && (earlier.moved || changedCell),
      };
      this.interruptions.set(mob.id, { interruption, distance: mob.distance, lastAt: now });
      if (most === null || interruption.count > most.count) most = interruption;
    }
    return most;
  }
}
