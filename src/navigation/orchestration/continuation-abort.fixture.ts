/**
 * Child process of the "plan-ahead search" test in `navigation-run.test.ts`.
 *
 * A runtime that lets a promise reject unhandled exits, and the test runner
 * does not reliably report one, so the scenario runs in a process of its own
 * and says on stdout whether the runtime saw one.
 *
 * The bot reaches the goal while the plan-ahead search is thinking, so the
 * arrival is judged by that background search; the caller's quantity is met
 * right then and the arrival callback throws the abort reason, a bare string.
 */
import { nearGoal } from "../goals/index.js";
import { createMovementPolicy } from "../movements/policy.js";
import { createNavigator } from "./navigator.js";
import { FakeNavigationBot, flatWorld, observation, settle } from "../../test-support/navigation.js";

const STEP_MS = 200;
const REASON = "the requested quantity is in the inventory";

process.on("unhandledRejection", (reason) => console.log(`UNHANDLED ${String(reason)}`));

setTimeout(async () => {
  const abort = new AbortController();
  const bot = new FakeNavigationBot();
  // Walking takes real time, so the plan-ahead search runs while the segment is under way.
  bot.prepareMovement = async (step) => {
    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
    bot.arrive(step.to);
    return { kind: "completed", arrival: step.to } as const;
  };
  let searching = false;
  const navigator = createNavigator({
    world: flatWorld(),
    bot,
    telemetry: {
      emit: (event) => {
        if (event.kind === "search_started") searching = event.reason === "segment_continuation";
        if (event.kind === "search_slice" && searching) bot.current = observation(5);
      },
      error: (_runId, cause) => console.log(`ERROR ${String(cause)}`),
    },
  });
  let arrivals = 0;
  const outcome = await settle(navigator, {
    goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
    policy: createMovementPolicy({ allowSprinting: false }),
    searchLimits: { primaryTimeoutMs: 0, failureTimeoutMs: 1_000 },
    signal: abort.signal,
    onArrival: () => {
      arrivals += 1;
      abort.abort(REASON);
      abort.signal.throwIfAborted();
      return { kind: "completed" };
    },
  });
  // Give a rejection nobody was waiting for the time to surface.
  await new Promise((resolve) => setTimeout(resolve, 2 * STEP_MS));
  console.log(`OUTCOME ${outcome.kind} arrivals=${arrivals}`);
}, 0);
