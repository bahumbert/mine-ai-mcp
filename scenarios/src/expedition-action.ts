// Captures expedition action results and their wave state at settlement.

/** Sample the wave before incident capture can yield to later spawn events. */
export async function runExpeditionAction<T>(options: {
  name: string;
  run: () => Promise<T>;
  isWavePending: () => boolean;
  capture: () => Promise<unknown>;
  record: (output: T) => void;
}): Promise<{ output: T; settledWithWavePending: boolean }> {
  const output = await options.run();
  const settledWithWavePending = options.name === "collect_mob_drop" && options.isWavePending() &&
    JSON.stringify(output).includes("HUNT_TARGET_NOT_LOADED");
  options.record(output);
  await options.capture();
  return { output, settledWithWavePending };
}
