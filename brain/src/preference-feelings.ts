// How a character's preferences read in the prompts: the long form of the init prompt and the short form the chat tier uses.
import { describeActivity } from "./activities.ts";
import type { Persona } from "./persona.ts";

/** "you love farming, like building, dislike fighting monsters, hate mining": the short form the chat tier's rules use. */
export function feelings(persona: Persona): string {
  const preferences = persona.preferences;
  if (preferences === undefined) return "";
  return `you love ${describeActivity(preferences.loves)}, like ${describeActivity(preferences.likes)}, dislike ${describeActivity(preferences.dislikes)}, hate ${describeActivity(preferences.hates)}`;
}

/**
 * What the character prefers and avoids (ADR-015), as a feeling the models weigh, never a rule: "You love farming and
 * like building; you dislike fighting monsters and hate mining. ..." Empty without preferences.
 */
export function describePreferences(persona: Persona): string {
  const preferences = persona.preferences;
  if (preferences === undefined) return "";
  const [loves, likes, dislikes, hates] = [preferences.loves, preferences.likes, preferences.dislikes, preferences.hates].map(describeActivity);
  // "In your own words": told to be "grumbling", Vex said "grumbling but I dig" (live 2026-10-04).
  return `You love ${loves} and like ${likes}; you dislike ${dislikes} and hate ${hates}. Your feelings show whenever work comes up:
glad about what you love, reluctant about what you dislike or hate, even when you do it anyway, said in your own words.`;
}
