// The brain's command line and the set of agents it must not answer; apart from `main.ts` so a test can import them
// (`main.ts` runs the brain on import, and `.agent/scripts/ops/brain-mem.ts` loads it that way).
import { parseArgs } from "node:util";

/** The brain's command line options: `bun brain/src/main.ts --help` lists them. */
export function parseBrainArgs(args: string[] = process.argv.slice(2)) {
  return parseArgs({
    args,
    options: {
      agent: { type: "string", multiple: true },
      "other-agent": { type: "string", multiple: true },
      "other-agents-file": { type: "string" },
      "chat-model": { type: "string" },
      "action-model": { type: "string" },
      "planner-model": { type: "string" },
      "known-names": { type: "string" },
      "model-slots": { type: "string" },
      "start-gap": { type: "string" },
      "start-when-free": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
}

/**
 * The usernames an agent must not answer: the other agents of this process and the `--other-agent` ones, never itself.
 * Names match without case, as the Agent compares them (`agent.ts` `listensTo`); the first spelling given is kept.
 */
export function otherAgentsFor(username: string, inProcess: readonly string[], extra: readonly string[]): string[] {
  const own = username.toLowerCase();
  const seen = new Set<string>([own]);
  return [...inProcess, ...extra].filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
