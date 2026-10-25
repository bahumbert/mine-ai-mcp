/** The client host's command line: the driver module, and whether the trial runs with our runtime attached. */

export const CLIENT_HOST_USAGE = "Usage: client-host.ts <driver module> [--without-runtime]";
/**
 * Runs the driver on the bare Mineflayer bot, with no runtime (no reflexes, no baseline body owners, no `call`): for
 * the contract checks, which measure the server and must not see our runtime act (2026-10-21: the idle-water control
 * aborted an eye-in-water dig).
 */
export const WITHOUT_RUNTIME_FLAG = "--without-runtime";

export interface ClientHostArgs {
  readonly driverFile: string;
  readonly withRuntime: boolean;
}

/** Read `client-host.ts`'s arguments; throws the usage on anything else. */
export function parseClientHostArgs(args: readonly string[]): ClientHostArgs {
  const [driverFile, ...flags] = args;
  const known = flags.every((flag) => flag === WITHOUT_RUNTIME_FLAG) && flags.length <= 1;
  if (!driverFile || driverFile.startsWith("--") || !known) throw new Error(CLIENT_HOST_USAGE);
  return { driverFile, withRuntime: flags.length === 0 };
}
