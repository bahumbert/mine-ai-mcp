// Threat facts and text for the view_status nearby section.
import type { Bot } from "mineflayer";
import { assessContacts } from "../../survival/control/combat/observation.js";
import { HOSTILE_CONTACT_RANGE, HOSTILE_OBSERVATION_RANGE, observeHostileContact } from "../../survival/perception/combat/threats.js";
import type { LiveSituation } from "./contract.js";
import type { HostileContext } from "../../survival/control/combat/context.js";

type Nearby = LiveSituation["nearby"];

/** Assess the same bounded hostile list that status reports. */
export function statusThreats(bot: Bot, fightMargin: number, context: HostileContext): Pick<Nearby, "hostiles" | "fight"> {
  const hostiles = observeHostileContact(bot, context).filter((hostile) => hostile.distance <= HOSTILE_OBSERVATION_RANGE);
  const assessment = hostiles.length ? assessContacts(bot, hostiles.map((hostile) => ({ ...hostile, inContact: hostile.distance <= HOSTILE_CONTACT_RANGE || context.attackerIds.has(hostile.id) })), context) : null;
  return {
    hostiles: hostiles.map((hostile, index) => {
      const contact = assessment!.contacts[index]!;
      const rounded = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
      return { name: hostile.name, distance: rounded(hostile.distance, 1), position: {
        x: rounded(hostile.position.x, 2), y: rounded(hostile.position.y, 2), z: rounded(hostile.position.z, 2),
      }, threat: { damagePerHit: contact.damagePerHit, hitsToKillYou: contact.hitsToKillBot,
        yourHitsToKill: contact.hitsToKill, explodes: contact.explosion !== null, unknownMelee: contact.unknownMelee } };
    }),
    fight: assessment ? { weapon: assessment.weapon.item, margin: assessment.margin, healthLostToClear: assessment.healthLostToClear,
      effectiveHealth: assessment.bot.effectiveHealth, ticksToDie: assessment.ticksToDie, ticksToClear: assessment.ticksToClear,
      fightMargin, source: assessment.source } : null,
  };
}

/** Summarize each contact without implying different mobs take the same number of hits. */
export function statusThreatLines(nearby: Nearby): string[] {
  const hostiles = nearby.hostiles.length ? nearby.hostiles.map((h) => `${h.name} ${h.distance} blocks away at \`${h.position.x}, ${h.position.y}, ${h.position.z}\``).join("; ") : "none";
  const lines = [`- Hostiles: ${hostiles}`];
  const fight = nearby.fight;
  if (!fight) return lines;
  const unknown = nearby.hostiles.filter((hostile) => hostile.threat.unknownMelee);
  if (unknown.length) {
    lines.push(`- Unknown melee cost for ${unknown.map((hostile) => hostile.name).join(", ")}; keep away, or hunt_mob it to fight anyway. A complete fight margin is unavailable for an unknown contact.`);
    return lines;
  }
  const groups = new Map<string, { name: string; hits: number; count: number }>();
  for (const hostile of nearby.hostiles) {
    const key = `${hostile.name}:${hostile.threat.yourHitsToKill}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { name: hostile.name, hits: hostile.threat.yourHitsToKill, count: 1 });
  }
  const targets = [...groups.values()].map((group) => `${group.name} x${group.count}: you need ${group.hits} hits each`).join("; ");
  if (fight.ticksToClear === 0) {
    lines.push(`- ${targets} (${fight.weapon ?? "bare hands"}); no damaging contact is priced; margin unknown`);
    return lines;
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  const margin = fight.margin === null ? "margin unknown" : `margin ${round(fight.margin)} ${fight.margin < fight.fightMargin ? "<" : "≥"} ${fight.fightMargin}`;
  lines.push(`- ${targets} (${fight.weapon ?? "bare hands"}), clearing damaging contacts in contact range or observed attacking costs ~${round(fight.healthLostToClear)} of ${round(fight.effectiveHealth)} health; ${margin}`);
  return lines;
}
