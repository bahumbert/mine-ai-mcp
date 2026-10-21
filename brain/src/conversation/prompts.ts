import type { LocalizedChat } from "../llm-mind.ts";
import { personaPrompt } from "../llm-mind.ts";
import type { ConversationFacts, GistInput, Nearby, OpeningInput, PastTalk } from "../mind.ts";
import type { Persona } from "../persona.ts";
import { PLANNED_LINES } from "./state.ts";

/**
 * The conversation prompts (spec 2026-10-18-conversations-design). The code states facts; the model decides whether to
 * talk, about what, for how long, and writes every line (Rule #0).
 */
export function openingSystemPrompt(persona: Persona, localizedChat?: LocalizedChat): string {
  const lengths = (["short", "medium", "long"] as const).map((length) => `"${length}" = ${PLANNED_LINES[length].join("-")} lines in all, every speaker counted`).join("; ");
  return `${personaPrompt(persona)}

You may start a conversation with someone near you, or not: "open" is false when you have nothing to say, and then nothing is said.
Reply with only a JSON object {"open": true, "to": ["Name"], "topic": "...", "length": "short", "say": "..."}.
- "open": true to start a conversation now, false to let this moment pass.
- "to": who you speak to, by name, from those near you; ["everyone"] to speak to all of them.
- "topic": what you want to talk about, in a few words.
- "length": how long you mean it to be: ${lengths}. A chance meeting while you work leans short; when you went to see someone, medium or long.
- "say": your first line, in your own words, one or two sentences, under 200 characters; name those you speak to in it, for they hear it as spoken to them only when it names them (a line naming nobody is heard by nobody).
${localizedChat === undefined ? "" : `Talk carries about ${localizedChat.range} blocks: only those within that distance hear you.\n`}When "calling" is given, the people you want are out of earshot: ${localizedChat === undefined ? "your line is plain talk, so they hear it only if they come close; say where you are or what you want" : "your line is shouted to call them over; say where you are or what you want"}.
Stay in character. Never mention being an AI, a model, a prompt, JSON or tools.`;
}

function describeNearby(near: Nearby): string {
  const where = near.distance === null ? "out of sight" : `${Math.round(near.distance)} blocks away`;
  const talk = near.lastTalk === null ? "never talked" : `last talk ${describeTalk(near.lastTalk)}`;
  return `- ${near.username}, ${where}; ${talk}`;
}

function describeTalk(talk: PastTalk): string {
  return `${talk.minutesAgo} min ago about ${talk.topic === "" ? "nothing in particular" : talk.topic}: ${talk.gist === "" ? "(no gist)" : talk.gist}`;
}

export function describeOpening(input: OpeningInput, localizedChat?: LocalizedChat): string {
  const parts = [
    `${input.calling ? "You want to call over" : "Near you"}:\n${input.near.map(describeNearby).join("\n")}`,
    `You are doing: ${input.activity}.`,
    ...(input.lately.length === 0 ? [] : [`Lately:\n${input.lately.slice(-3).map((line) => `- ${line}`).join("\n")}`]),
    ...(input.relations === undefined || input.relations.length === 0 ? [] : [`What you know of them:\n${input.relations.map((line) => `- ${line}`).join("\n")}`]),
    ...(input.lastFailed === null ? [] : [`Your last objective "${input.lastFailed.objective}" failed: ${input.lastFailed.reason}.`]),
    ...(input.calling ? [localizedChat === undefined ? "calling: they are out of earshot, your line is plain talk and may not reach them." : "calling: they are out of earshot, your line is shouted to call them over."] : []),
    input.kind === "social" ? "You chose to go and talk with them." : "You meet them while you work.",
    ...(input.intent === undefined ? [] : [`You came to trade: ask for ${input.intent.want.join(", ")}, offer some of ${input.intent.offer.map((o) => `${o.count} ${o.item}`).join(", ")}; say what you would give.`]),
  ];
  return parts.join("\n\n");
}

/** The "This conversation" block of a chat request. */
export function conversationBlock(facts: ConversationFacts): string {
  const lines = [`- With ${facts.others.join(", ")}.`];
  lines.push(facts.iAmOpener
    ? `- You opened it${facts.topic === "" ? "" : ` about ${facts.topic}`}.`
    : `- ${facts.opener} opened it${facts.topic === "" ? "" : ` about ${facts.topic}`}.`);
  lines.push(`- ${facts.lines} lines so far, ${facts.minutes} min.`);
  if (facts.iAmOpener && facts.planned !== null) {
    lines.push(`- As its opener, you meant it to be ${facts.planned} (${PLANNED_LINES[facts.planned].join("-")} lines in all).`);
  }
  lines.push(facts.sayGoodbye
    ? `- It has gone on long enough: say goodbye now and set close true.`
    : `- You may end it when it has run its course: give your goodbye in say and set close true.`);
  for (const talk of facts.lastGists) lines.push(`- Last time with ${talk.with.join(", ")}: ${describeTalk(talk)}.`);
  return `This conversation:\n${lines.join("\n")}`;
}

export function gistSystemPrompt(persona: Persona, withPartners = false): string {
  return `${personaPrompt(persona)}

A conversation you were in has ended. Sum it up for your memory in one sentence, first person: what was talked about and anything agreed (who does what for whom).
${withPartners ? `Then say how you feel about each of the others now, from what you know of them and what they said and did, and note what they said they have or need.
Reply with only a JSON object {"gist": "...", "partners": [{"name": "...", "feeling": 0, "word": "...", "why": "...", "has": ["item_id"], "needs": ["item_id"]}]}.
- "feeling": a whole number from -3 (dislike, distrust) to +3 (fondness, trust); 0 is neutral. "word": one word. "why": one sentence in your own words.
- "has" and "needs": Minecraft item ids they said they have or need in this conversation; [] when they said none.` : `Reply with only a JSON object {"gist": "..."}.`}`;
}

export function describeGist(input: GistInput): string {
  const lines = input.lines.map((line) => `${line.speaker}: ${JSON.stringify(line.text)}`).join("\n");
  const known = (input.relations ?? []).map((r) => r.block).join("\n");
  return `You talked with ${input.others.join(", ")}${input.topic === "" ? "" : ` about ${input.topic}`}.\n\n${known === "" ? "" : `What you knew of them:\n${known}\n\n`}What was said:\n${lines === "" ? "(nothing)" : lines}`;
}
