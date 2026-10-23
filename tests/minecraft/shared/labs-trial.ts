// The one place that calls Mine Labs' runScenarioTrial: a trial on a Mine Labs server, with the lane's arena options.
import { runScenarioTrial, type ScenarioTrialOptions } from "mine-labs";
import { labsServerOf } from "./labs-server.ts";
import type { TrialRunner } from "./trial.ts";

export const runLabsTrial: TrialRunner = input => {
  const options: ScenarioTrialOptions = {
    scenario: input.scenario, server: labsServerOf(input.server), runDir: input.runDir, log: input.log, signal: input.signal,
    reuseServer: input.reuseServer, deferReset: input.deferReset, onPrepared: input.onPrepared, arena: input.arena,
  };
  return runScenarioTrial(options);
};
