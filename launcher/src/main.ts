// `mine-ai`: the launcher's command line. Run as `bun launcher/src/main.ts <command>` (the installer, the Start-menu
// entry and the player do exactly that). Each command lives in its own module; this file only routes and reports.
import { join } from "node:path";
import { realCliContext, UsageError, type CliContext } from "./cli-context.ts";
import { EXPECT_CONSOLE_FLAG, realConsoleDeps, runConsole, type ConsoleDeps } from "./client.ts";
import { runConfigureCommand, type ConfigureDeps } from "./configure-command.ts";
import { realControlCommandDeps, runBotCommand, runStatusCommand, runStopCommand, type ControlCommandDeps } from "./control-commands.ts";
import { realDoctorDeps, runDoctor, type DoctorDeps } from "./doctor.ts";
import { realInstallSteps, runInstallCommand, type InstallSteps } from "./install-command.ts";
import type { Manifest } from "./manifest.ts";
import { dataRoot } from "./paths.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { guardWithJobObject, realStartDeps, runStartCommand, type StartDeps } from "./start-command.ts";

export const COMMANDS = ["console", "start", "stop", "status", "doctor", "install", "configure", "bot", "help"] as const;

export const USAGE = `Usage: mine-ai <command>
  help | --help | -h            show this text (nothing is started)
  console                       open Mine AI (starts it if needed; closing the window stops it)
  start                         run the background launcher (the console does this for you)
  stop                          stop Mine AI
  status                        what is running
  doctor                        versions, GPU answer, ports, settings and the last errors, for a bug report
  bot start|stop <persona id or name>   start or stop one bot while Mine AI runs
  install <gpu|disk|ollama|ollama-remove|model|model-remove|java|server|endpoint-test|endpoint-models> [--accept-eula] [--dir <ollama folder>] [--no-model] [--json <file>]
            (--dir: ollama and disk only; --no-model: disk only; disk lists the free space and what a local model and server need)
  install endpoint-models --list <file> [--url <url>] [--key <key> | --saved-key] [--json <file>]
            (writes the models the remote endpoint lists, one per line; without --url it reads the saved settings)
  configure --llm-local | --llm-remote <url> <key> <model> | --llm-remote-saved-key <url> <model>   and/or   --server-none | --server-local | --server-remote <host> <port>
            and/or   --command-players <name,name,...>   (players who may give !bot commands in chat; "" clears them)
            and/or   --check-updates on|off   (whether each start checks GitHub for a newer release)`;

const HELP_FLAGS: readonly string[] = ["--help", "-h"];

/** Everything a command reaches outside the process through; tests replace the parts they exercise. */
export interface CliDeps {
  installSteps: InstallSteps;
  startDeps: () => StartDeps;
  controlDeps: (root: string) => ControlCommandDeps;
  consoleDeps: (root: string, appRoot: string) => ConsoleDeps;
  doctorDeps: (root: string, manifest: Manifest, appRoot: string) => DoctorDeps;
  configureDeps?: ConfigureDeps;
  /** The kill-on-close job object for commands that start programs; the warning text when Windows refuses. */
  guardChildren: () => string | null;
}

const realDeps: CliDeps = {
  installSteps: realInstallSteps,
  startDeps: realStartDeps,
  controlDeps: realControlCommandDeps,
  consoleDeps: realConsoleDeps,
  doctorDeps: realDoctorDeps,
  guardChildren: guardWithJobObject,
};

async function runDoctorCommand(context: CliContext, deps: CliDeps): Promise<number> {
  const manifest = context.loadManifest();
  let settings: Settings;
  try {
    settings = loadSettings(context.root, manifest);
  } catch (error) {
    context.out(`Settings problem: ${(error as Error).message}`);
    // The rest of the report still helps a bug report: show it with the defaults.
    settings = loadSettings(join(context.root, "no-settings-file"), manifest);
  }
  (await runDoctor(context.root, manifest, settings, deps.doctorDeps(context.root, manifest, context.appRoot))).forEach(context.out);
  return 0;
}

/**
 * What the commands that parse nothing themselves accept after their name: `allowed` lists the arguments, `max` caps how
 * many there are (`bot` checks its own action and id, and says what it lacks). `install` and `configure` parse their own.
 */
type ArgumentRule = { readonly allowed: readonly string[] } | { readonly max: number };
// Typed over COMMANDS: a command added there without a rule (or an exemption here) fails the typecheck.
const ARGUMENTS_TAKEN: Readonly<Record<Exclude<(typeof COMMANDS)[number], "install" | "configure" | "help">, ArgumentRule>> = {
  console: { allowed: [] },
  stop: { allowed: [] },
  status: { allowed: [] },
  doctor: { allowed: [] },
  // The flag the console passes; it is not in USAGE, so the refusal never offers it (typed by hand it makes the launcher quit).
  start: { allowed: [EXPECT_CONSOLE_FLAG] },
  bot: { max: 2 },
};

function refuseArgumentsNotTaken(command: string, args: readonly string[]): void {
  const taken = (ARGUMENTS_TAKEN as Readonly<Record<string, ArgumentRule | undefined>>)[command];
  if (taken === undefined) return;
  const refused = "max" in taken ? args[taken.max] : args.find((argument) => !taken.allowed.includes(argument));
  if (refused !== undefined) throw new UsageError(`"${command}" does not take "${refused}".`);
}

async function runCommand(command: string, args: string[], context: CliContext, deps: CliDeps): Promise<number> {
  refuseArgumentsNotTaken(command, args);
  switch (command) {
    case "console":
      return await runConsole(deps.consoleDeps(context.root, context.appRoot));
    case "start":
      return await runStartCommand(context, deps.startDeps(), { expectConsole: args.includes(EXPECT_CONSOLE_FLAG) });
    case "stop":
      return await runStopCommand(context, deps.controlDeps(context.root));
    case "status":
      return await runStatusCommand(context, deps.controlDeps(context.root));
    case "bot":
      return await runBotCommand(args, context, deps.controlDeps(context.root));
    case "doctor":
      return await runDoctorCommand(context, deps);
    case "configure":
      return await runConfigureCommand(args, context, deps.configureDeps);
    case "install": {
      // Ollama's setup and our serve then end with this process if it is killed (an installer cancelled mid-download).
      const warning = deps.guardChildren();
      if (warning) context.err(`Warning: ${warning}. If this install is killed, a program it started may keep running.`);
      return await runInstallCommand(args, context, deps.installSteps);
    }
    default:
      throw new UsageError(command === "" ? "No command given." : `Unknown command "${command}".`);
  }
}

/** Runs one command line; the exit code is 0 for success, 1 for a failure, 2 for arguments it does not take, 3 for a `stop` the launcher refused (`STOP_REFUSED_EXIT_CODE`). */
export async function runCli(argv: readonly string[], context: CliContext, overrides: Partial<CliDeps> = {}): Promise<number> {
  const [command = "", ...args] = argv;
  // Before any routing: no command may start a program when the player only asked how to use it.
  if (command === "help" || argv.some((argument) => HELP_FLAGS.includes(argument))) {
    context.out(USAGE);
    return 0;
  }
  try {
    return await runCommand(command, args, context, { ...realDeps, ...overrides });
  } catch (error) {
    const isUsage = error instanceof UsageError || (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS") === true;
    context.err((error as Error).message);
    if (isUsage) context.err(USAGE);
    return isUsage ? 2 : 1;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2), realCliContext(dataRoot())));
}
