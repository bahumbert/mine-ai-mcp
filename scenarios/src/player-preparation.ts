// The legacy scenario host's arrangement handshake, before driver preparation.
import type { Bot } from "mineflayer";
import type { NodeClientSession } from "mine-labs/client";
import { observeScenarioPlayerPreparation } from "../../tests/minecraft/player-preparation.ts";

/** End before Mine Labs' 60-second prepared handshake so the missing updates reach its result. */
const ARRANGED_WALL_MS = 45_000;

/** Observe declared player updates before the host starts the scenario driver. */
export async function prepareScenarioPlayer(
  bot: Bot,
  session: Pick<NodeClientSession, "scenario" | "signal" | "ready" | "arranged">,
  options: { readonly wallMs?: number } = {},
): Promise<void> {
  const wallMs = options.wallMs ?? ARRANGED_WALL_MS;
  const bound = new AbortController();
  const signal = AbortSignal.any([session.signal, bound.signal]);
  const preparation = observeScenarioPlayerPreparation(bot, session.scenario, signal);
  const step = { name: "arranged player", missing: preparation.describePending };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    session.ready();
    await session.arranged;
    session.signal.throwIfAborted();
    timer = setTimeout(() => bound.abort(new Error("preparation bound")), wallMs);
    await preparation.wait();
  } catch (cause) {
    session.signal.throwIfAborted();
    if (bound.signal.aborted) throw new Error(`Bot '${bot.username}' was not prepared within ${wallMs / 1000} s of the arrangement, stuck at '${step.name}': ${step.missing()}`);
    throw cause;
  } finally {
    clearTimeout(timer);
    preparation.close();
  }
}
