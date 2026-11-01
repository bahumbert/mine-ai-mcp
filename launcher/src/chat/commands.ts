// Runs one parsed chat command against the launcher's bots and answers the player (spec D1, D2).
import { findPersona, type PersonaEntry } from "../personas.ts";
import type { ChatCommand } from "./parse.ts";

type BotStatus = "starting" | "running" | "stopping" | "ended";
type ControlOutcome = { ok: boolean; message: string };

/** What a chat command may do to the stack; the launcher implements it over its bot start and stop. */
export interface BotControl {
  personas(): readonly PersonaEntry[];
  bots(): readonly { id: string; username: string; status: BotStatus }[];
  start(id: string): Promise<ControlOutcome>;
  stop(id: string): Promise<ControlOutcome>;
}

/** Text from chat shown back to the player or the console: control characters and `§` would be refused by a host or garble the log. */
const printable = (text: string): string => text.replace(/[\p{Cc}\p{Cf}§]/gu, "?");

const byUsername = (a: PersonaEntry, b: PersonaEntry): number => a.username.toLowerCase().localeCompare(b.username.toLowerCase());

function listAnswer(control: BotControl): string {
  const playingIds = new Set(control.bots().filter((bot) => bot.status !== "ended").map((bot) => bot.id));
  const personas = [...control.personas()].sort(byUsername);
  if (personas.length === 0) return "No bot is set up: add a persona file (<name>.json with a username) to the personas folder.";
  const notStarted = personas.filter((persona) => !playingIds.has(persona.id)).map((persona) => persona.username);
  const playing = personas.filter((persona) => playingIds.has(persona.id)).map((persona) => persona.username);
  if (notStarted.length === 0) return playing.length > 0 ? "All bots are playing." : "No bot is playing.";
  return `Not started: ${notStarted.join(", ")} | ${playing.length > 0 ? `Playing: ${playing.join(", ")}` : "No bot is playing."}`;
}

async function settle(action: () => Promise<ControlOutcome>, failure: string): Promise<string> {
  try {
    return (await action()).message;
  } catch (error) {
    return `${failure}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function startBot(control: BotControl, persona: PersonaEntry, answer: (text: string) => Promise<void>): Promise<string> {
  const isActive = control.bots().some((bot) => bot.id === persona.id && bot.status !== "ended");
  if (!isActive) await answer(`Starting ${persona.username}...`);
  return settle(() => control.start(persona.id), `Could not start ${persona.username}`);
}

async function stopBot(control: BotControl, persona: PersonaEntry, answer: (text: string) => Promise<void>): Promise<string> {
  const isPlaying = control.bots().some((bot) => bot.id === persona.id && (bot.status === "starting" || bot.status === "running"));
  if (isPlaying) await answer(`Stopping ${persona.username}...`);
  return settle(() => control.stop(persona.id), `Could not stop ${persona.username}`);
}

/**
 * Runs a command and answers through `answer`; returns the console summary `<command> -> <last answer>`.
 * A failing `answer` never stops the command: its error is added to the summary.
 */
export async function runChatCommand(
  command: ChatCommand,
  control: BotControl,
  answer: (text: string) => Promise<void>,
  prefix: string,
): Promise<string> {
  let lastAnswer = "";
  const failures = new Set<string>();
  const say = async (text: string): Promise<void> => {
    lastAnswer = text;
    try {
      await answer(text);
    } catch (error) {
      failures.add(error instanceof Error ? error.message : String(error));
    }
  };

  let commandText = `${prefix}bot help`;
  if (command.kind === "help") {
    await say(`Commands: ${prefix}bots, ${prefix}bot start <name>, ${prefix}bot stop <name>`);
  } else if (command.kind === "list") {
    commandText = `${prefix}bots`;
    await say(listAnswer(control));
  } else {
    const name = printable(command.name);
    commandText = `${prefix}bot ${command.kind} ${name}`;
    const persona = findPersona(control.personas(), command.name);
    if (!persona) await say(`No bot named ${name}. Type ${prefix}bots for the list.`);
    else await say(await (command.kind === "start" ? startBot : stopBot)(control, persona, say));
  }
  return `${commandText} -> ${lastAnswer}${failures.size > 0 ? ` (answer failed: ${[...failures].join("; ")})` : ""}`;
}
