# Minecraft scenarios

Each fixture owns three things: the world and player arrangement, the action
request, and the expected outcome.

Verify scenario drivers by running their Minecraft scenarios, rather than
maintaining unit tests that repeat their assertions. Unit coverage belongs to
shared harness behavior: readiness, cancellation, cleanup, and the rule that an
unexpected action outcome cannot become a successful completion.

Starting worn or held items belong under `players[].equipment`, for example
`equipment: { head: golden_helmet }`. Mine Labs equips these before the trial;
drivers should only call `equip` when equipping is part of the behavior under test.

Everything for this suite lives here: shared host files at the top level,
replaceable test logic in `drivers/`, YAML defaults in `templates/`, and runnable
cases in `scenarios/`. Point Mine Labs at `scenarios/`, not this whole directory:
it recursively discovers every YAML file, including templates.

Group scenarios by behavior: `collect`, `craft`, `build`, `bucket`, `barter`,
`drop`, `explore`, `hunt`, `combat`, and `pathfinder`. World type and multi-location
verification belong in the fixture's YAML, so flat and natural-world cases
appear together when reviewing a capability.

## One action, specified in YAML

Each scenario also declares its purpose in `description` and its type in `tags`:

- `acceptance`: a capability or behavior we expect to work.
- `regression`: a known failure we want to keep fixed; describe that failure too.
- `reliability`: repeated execution exposes marginal movement or control behavior.

Keep scenarios in their behavior folders. In Mine Labs, press **F9** to inspect
the current or most recently run scenario, including its purpose and live goals.
F9 again or Escape returns to where you were; trials continue while reading.
The shortcut is remappable in Minecraft Controls → Mine Labs. F10 opens the
dashboard, where every tag has a text badge with a consistent automatic color,
and tags can filter across folders. The meanings above belong to this suite;
Mine Labs accepts arbitrary labels and assigns no meaning to their colors.
Filters affect the list; **Run folder** and **Run all** still run their whole scope.

```yaml
tags: [regression]
description: >-
  Reproduce a known failure, explain its trigger, and state the expected outcome.
```

For example, a single coal collection asks:

```yaml
params:
  action: collect_block
  input:
    block_name: coal_ore
    count: 5
    scaffold: false
```

`drivers/single-action.ts` reads that envelope, calls the named action
once, and checks its expected result (success by default). Any action registered by the runtime
can be selected; there is no action-specific driver or switch statement.
Use `input: {}` for an action with no arguments. Action schemas validate the
input; the driver validates the request envelope and optional expectation.

For an expected partial result or refusal, declare it separately from the input:

```yaml
params:
  action: collect_block
  input: { block_name: stone, count: 4, scaffold: false }
  expect:
    status: partial
    errorContains: "[INVENTORY_FULL]"
```

`expect.status` accepts `succeeded`, `partial`, or `failed`. Optional
`errorContains` matches literal text, not a regular expression. Both conditions
must match; mismatches report the expectation alongside the actual action
summary. Runtime failures and cancellations always fail the trial. These are
our driver's parameters, not Mine Labs goal types.

`expect.interruptionContains` can require a recorded interruption reason. The
combat collection case checks `[HOSTILE_CONTACT]` so merely finishing before the
zombie arrives cannot pass. This proves interruption of the collection action;
it does not assert which mining animation frame was interrupted.

For a short sequence that shares one fixture, select `drivers/action-sequence.ts`:

```yaml
client:
  command: bun
  cwd: ../..
  args: [client-host.ts, drivers/action-sequence.ts]
params:
  actions:
    - { action: collect_block, input: { block_name: coal_ore, count: 3, scaffold: false } }
    - { action: collect_block, input: { block_name: iron_ore, count: 3, scaffold: false } }
```

Every step must succeed, and the sequence stops on the first failure. Final
inventory and world assertions stay in Mine Labs goals. Use a custom driver only
when the scenario needs logic beyond an ordered list of successful calls.

A scenario's `params` hold arena-local coordinates (the same YAML runs at offset zero and in a shared-server lane). A
driver parses them through `arena/params.ts` built from `context.arena` (`arenaPoint`, `arenaCell`, `arenaX`), passes an
action input taken from params through `arenaActionInput(input, context.arena)`, and compares an observed position only
with those world-coordinate values; `drivers/lane-offset.test.ts` fails a driver that skips this.

## Combined behavior scenarios

Related regressions share a fixture while retaining their own stage or physical
assertion:

| Scenario | Coverage folded into it |
| --- | --- |
| [workshop](scenarios/craft/workshop.yaml) | Nine-log crafting, door recipe output, smelt-batch-lag, temporary furnace smelting, and floating furnace recovery. |
| [exact-collection-preservation](scenarios/collect/exact-collection-preservation.yaml) | Exact coal and birch door targets, explicit chest/table collection, protected storage and return navigation. |
| [movement-course](scenarios/pathfinder/movement-course.yaml) | The original constrained stair descent, ramps, soul sand, vines, ladders and unsupported diagonal treads. |
| [gauntlet-lava-parkour](scenarios/pathfinder/gauntlet-lava-parkour.yaml) | Maximum gap crossings plus the obstacle course's steps, drops, magma detour and door. Repeat it for movement reliability. |
| [cave-excavation-course](scenarios/pathfinder/cave-excavation-course.yaml) | Carpet maze, dripstone stairs and the unavoidable sand curtain. |

`navigate-route.ts` checks each named arrival with `view_status`, after ten
physics ticks let the final landing settle. It requires full health at every
checkpoint. Digging defaults to false; only the cave excavation course enables
it. Scaffolding is always disabled. Mine Labs also checks the final position,
health, deaths and protected or cleared blocks independently.

The workshop runs at 16 TPS and checks inventory between stages, before later
calls can consume or replace evidence. Its temporary batch cooks nine items
across two coal, beyond the old premature recovery deadline. Both furnace modes
must report the quantities actually carried, and the temporary furnace must be
recovered. Cooking into an existing ingot stack also checks output accounting.

Keep assertions that prevent a false pass: the arrow hunt checks the sole
unenchanted bow's unchanged durability, the netherrack bank measures at most 64
blocks removed for 32 collected, and coal-under-sand disables regeneration so
healing cannot hide suffocation damage. These checks use ordinary observation
actions through the existing host; no driver controls the bot or changes policy.

## Independent world goals

Mine Labs checks the outcome independently:

```yaml
goal:
  kind: all
  timeout: 45
  goals:
    - { kind: hasItem, item: coal, count: 5 }
    - { kind: completion }
```

The first goal reads the player's inventory on the Minecraft server. The
second requires the driver to report success. Neither the action's claim nor
the inventory alone can pass this test. Omitting `who` selects the first player.
The timeout is the trial's budget, not an action timeout.

## Shared setup

`templates/flat-single-action.yaml` owns the shared flat world, reset region,
spectator rule, and client command. It lives beside `scenarios/` so Mine Labs
will not discover it as a runnable test.

Fixtures using it live in `scenarios/<category>/`. The default spectator rule
expects one player named `Actor`; fixtures with other player names override
`tick` to preserve those participants. Each fixture declares its own position,
equipment and geometry.
The client working directory resolves from each fixture to this suite's root;
the host and driver arguments are relative to that root.
The reset region covers these collect arenas; a larger arena must override it.
Mine Labs replaces whole top-level fields when merging templates, so a fixture
overriding `world` or `client` must supply that entire field.

The host connects the bot, observes the arranged player state, and waits for
landing and vitals before creating the runtime and reporting prepared.
It observes a health packet rather than using food level as a readiness check.
Physics is paused only while setup waits for the declared player state and
starting terrain. It resumes before landing, with no spawn handler left to
pause physics during execution.
Starting grounded is the default. Add an exception only when a real fixture
needs to start off the ground; there is no configuration option for it now.
The action starts only after Mine Labs sends `start`.

## Contract checks: the fake bot against the real server

`contract/` holds the answers of Mineflayer and a 1.21.4 server that the shared fake bot
(`src/test-support/fake-bot/`) must give: each check in `contract/checks/` is one module
`{ name, fixture, run(subject) }` acting on the bot directly and asserting with `node:assert`.
The same check runs twice:

- on the fake, by `contract/bot-contract.test.ts` (`bun test`, mocked clock);
- on the real server, by `contract/scenarios/<check>.yaml` (tag `contract`) with
  `drivers/bot-contract.ts`. This driver is the one that acts on the bot itself
  and sends op commands as chat (`setblock`, `execute ... on vehicle`): the YAML's
  player is `op: true`. A check our runtime would disturb (its idle-water control, its
  vehicle watch) runs on the bare bot: `client-host.ts <driver> --without-runtime`.

The subject (`contract/subject.ts`) is `{ bot, wait, now, setBlock, seatedOnServer, setWeather, summonItem, hurtBot, kill, explode }`:
wall time and op commands on a server, the harness clock and its server side on
the fake. A YAML's `setup`, player and entities equal `setupCommands(check.fixture)`
(`contract/setup-commands.test.ts` fails on a YAML edited alone).

**The rule:** only a contract change changes the fake. A fake answer that differs
from the server shows as a check red on the server; the fake and its own test
change in the same commit as the check. A test that needs an answer the fake lacks
gets a new check first. Run them before any change to the fake, not in the soak run
(owner, 2026-10-21): their YAMLs live in `contract/scenarios/`, outside the `scenarios/`
folder that `bun run scenarios` and `scenarios:once` take.

```bash
bunx --bun mine-labs run tests/minecraft/contract/scenarios --repeat 3 -p <port>
```

## Shared server: many scenarios at once

`bun run scenarios:once` (and `bun tests/minecraft/shared/submit.ts <yaml|dir>...`) send the scenarios to one
long-lived daemon instead of starting a Mine Labs server per run. The daemon keeps one or more servers per **settings
key** (world type, seed, time, difficulty, tick rate and the effective value of every gamerule) warm, and runs each
scenario on a **lane** of such a server: the scenario is shifted to `z = 512 × lane` (`tests/minecraft/arena/`), so
many arenas share one world. A scenario the shift refuses (a natural `default` world, a settings verb it cannot
lift, a `kill` goal, tag `exclusive`...) gets a server of its own at offset 0, started at the same time as the others.
A scenario whose client is not `tests/minecraft/client-host.ts` (every legacy `scenarios/` YAML: its driver does not
read the arena frame, so its coordinates would stay at offset zero) also gets a server of its own; the daemon log
names the reason (`placement.ts`, T7e4). The next scenario on a reusable server of its own logs in under another player
name (body 1, 2...: `<name>L0<body>`), like the trials of a lane, so no air or hotbar slot is saved from its predecessor.

- **Admission is detected, never a fixed count.** Every 5 s the daemon reads each server's tick time P95 (`tick query`),
  the CPU busy share (`/proc/stat`) and `MemAvailable`, and starts a trial (and a new server for it, at most one per
  sample) only while every bound holds: P95 under 25 ms, CPU under 85 %, the memory ledger (what busy servers and young
  clients still have to grow into; idle warm servers are not counted, a trial admitted onto one needs its growth
  free too) covers the client, the concurrency target (starts at 28, see below) is not reached.
  With none of its own trials running the daemon admits one whatever the foreign load. Submissions take turns (a batch
  never waits behind another's whole queue), and a trial that has waited 3 samples for room for a new server keeps
  that room from the trials after it. A trial that waits prints the bound that holds it every 30 s. Constants and their
  env overrides (`MINE_AI_SCENARIO_*`): `tests/minecraft/shared/config.ts`.
- **The target follows demand and our own load.** It grows by one when, in the last pass, a queued trial was refused
  by the target alone, no bound was breached for 60 s (`GROW_AFTER`), the last growth is 15 s old (`GROW_EVERY`) and the
  cpu projected with one more trial of ours stays under 85 %; it has no ceiling of its own. A cpu breach with our trials
  running halves it only when the daemon's own process tree (itself, the java servers, the clients) used at least half of
  the busy cpu (`OWN_SHARE_HALVE`, read from `/proc/<pid>/stat`); under that the load is other workers' and only the
  cpu bound holds admission (log `target change: foreign load`). A full memory ledger leaves the target alone (it refuses admissions itself, and stops growth).
- **A shared server takes no lane that would wait too long for the arrangement turn.** One arrangement or restore at a
  time per server: a lane trial counts on its server's queue from admission until its arrangement is done, and again
  while its restore is queued or running. A server whose queue would make the next trial wait over 5 s
  (`ARRANGE_QUEUE_MS`; the median mutex time of its last 20 trials, 800 ms until 3 trials settled) is passed over, so
  the next server of the key (a new one, when memory allows) takes the trial; when no new server can start, the trial
  takes the server with the shortest queue rather than wait.
- **The daemon log** (`.tmp/scenario-server/daemon.log`) has, per sample, `sample: ... | cpu= own= load1= mem= ledger=
  target= running= queued= servers= starts= held=<bound:count,...>` (and `target change: halved|foreign load|grew`),
  per settled trial `trial <name> lane <k|own> server <id> queue= serverWait= mutexWait= arrange= join= trial=
  restoreWait= restore= hold=` (ms: submission to admission, server not yet ready, the six phases of the run log, admission
  to the lane's return), and per server `server <id> (...) starting: <reason>` / `stopping: <reason>`.
- **Killing the submitter ends its trials, not the daemon.** `submit` going away (Ctrl-C, `kill`, even `kill -9` of a
  script that wraps it) closes its socket: the daemon cancels that submission's queued and running trials and goes on
  serving the others; its servers stay warm for the next submit.
- **A timing batch gets servers of its own, nothing global** (`--lock`, owner 2026-10-24). Scenarios that count ticks or
  world age (`world-age-per-second`, `attack-cooldown-damage`, the contract checks with a "measured bound") run with
  `--lock --lanes 1`: the daemon makes servers for that batch alone, gives them no trial of another submission, starts
  its trials only while the machine's CPU is under `CPU_CALM` (60 %), and stops the servers when the batch ends. Other
  batches keep running on their own servers beside it, but while a timing trial runs, or waits for a calm machine, they
  start only under `CPU_CALM` too. A scenario tagged `exclusive` is a timing trial by itself (server of its own, same calm rule). The one hold
  left is `--hold` (the master's `scenario-repeat.sh --load`, a load-only flake fix): it waits for the queue ahead
  of it to empty and admits nothing else until it ends.
- **Lanes are free slots** handed out lowest first and held until the trial and its restore have settled; a trial is
  aborted at `goal.timeout` + 120 s on the wall clock, and a server whose restore or abort does not finish in 60 s is
  marked sick (no admission, stopped once it drains). One arrangement or restore at a time per server.
- **Commands** (all through `submit.ts`; scripts `scenario-run.sh` and `scenario-repeat.sh` call it):
  `--repeat N`, `--lanes N` (at most N of this submission's trials at once; 1 = one at a time), `--lock` (servers of
  the batch's own on a calm machine: timing batches; no file lock), `--hold` (master only: runs alone once the queue
  ahead is empty), `--out DIR`
  (evidence, default `.mine-labs`), `--isolated` (today's `mine-labs run`, one server per worker), `--stop` (daemon
  stops once its trials end; `bun run scenarios:stop`). The clients run from the YAML's own checkout, so a worker tests
  its own code; the submitter's `MINE_AI_*` variables reach the clients through `client.env`.
- **The daemon** listens on `/tmp/mine-ai-scenarios.sock`, owns game ports 25400-25559, logs to
  `.tmp/scenario-server/daemon.log` of the checkout that started it, exits after 10 idle minutes. A change to
  `tests/minecraft/arena`, `tests/minecraft/shared` or `patches/` is tested on a daemon of its own: `--socket
  /tmp/mine-<name>.sock --port <base>` (40 ports from `<base>`, below 25360 so it meets neither the default block nor
  25566-25574 and 25575+). After a kill of the daemon the next start kills the java servers it left (`.tmp/scenario-server/pids`, by PID).

## Runtime boundary and evidence

The host builds `createMinecraftRuntime` once. Drivers receive only `scenario`
and `call(action, input)`. The bot, runtime, cancellation and action recording are
owned by the host.
`call` records the request, runs the registered action, records its full output
and summary, and returns them. It does not decide whether a test passed.
The host closes the runtime before reporting completion so artifacts are flushed.

The implementation has three responsibility boundaries:

- `client-host.ts`: load the driver, prepare the bot, run the trial, report completion.
  Action lookup, execution, recording and summaries live together in this file.
  The runtime is scoped with `await using`, so every exit disposes it before reporting.
- `scenario-bot.ts`: connect, observe arrangement, wait for landing, and disconnect.
  After completion the bot stays connected for Mine Labs' final world observations;
  Mine Labs' stop signal closes it. A setup or host failure also closes it.
- `drivers/single-action.ts`: read the YAML request, call the action, and check its expected result.

Player-arrangement observation uses the shared helper at
`player-preparation.ts` (next to this README).

`runWithRuntime` creates the runtime and waits for the start signal before timing
the driver's run. Preparation
errors reach Mine Labs' client error handler; execution errors become failed
completions with elapsed time. Cancellation unwinds cleanup without reporting a
second outcome for a trial Mine Labs has already stopped.

This suite tests actions directly through `runtime.run()`, with the runtime's
navigation, reflexes, survival and incident recording. It does not exercise MCP
transport, async submission IDs, or the submit/wait/result-retrieval protocol.
Its call-log entries contain the action input and output, not MCP replies.

When the template declares the highlighter, `scenario-highlighter.ts` exposes
its loopback feed at the game server port plus the declared offset. It passes
the highlighter into the runtime for action block highlights and subscribes to
`runtime.navigation.onEvent` for committed routes. It adds no movement behavior;
the subscription and listener close with the runtime. Multi-player fixtures show
the first declared participant. Without a polling viewer, action block highlights
are inactive; route events only replace the latest path. Built-in incident
recording and progress tracking remain unchanged.

Runtime evidence is temporary by default: bot SQLite stays in memory, and incident
files are removed after the runtime closes, even if the driver fails or is cancelled.
Mine Labs still retains its normal results, scenario snapshots and client/server logs.
Existing artifacts from earlier runs are not removed by this setting.

To retain the SQLite database and incident files for an investigation, set the
host's `MINE_AI_SCENARIO_EVIDENCE=1` environment variable before launching Mine Labs:

```powershell
$env:MINE_AI_SCENARIO_EVIDENCE = "1"
try {
  bunx --bun mine-labs run tests/minecraft/scenarios/collect/sand-single.yaml --repeat 1
} finally {
  Remove-Item Env:MINE_AI_SCENARIO_EVIDENCE
}
```

Only the exact value `1` enables retention. Evidence goes under that trial's
Mine Labs artifact directory (`bot-data/` and `<username>/incidents/`) and follows
Mine Labs' run retention. This is a client-host option, not a scenario parameter
or Mine Labs setting. For the dashboard, use the same variable with
`bun run scenarios:spectator`; it applies to every trial in that launched session.

Use the single-action driver for expected success, partial progress, or refusal,
with Mine Labs goals for inventory and world observations. Custom drivers are
for sequences, timing checks, dynamic inputs, or action-specific evidence that
these expectations and world goals cannot express.

A driver exports `run(context): Promise<ClientCompletion>`. There are no
preparation or runtime-configuration hooks. Add capabilities to this contract
only when a real fixture needs them. Shared connection, recording and cleanup
stay in the host.

Run the Minecraft suite once:

```bash
bun run scenarios:once   # = bunx --bun mine-labs run tests/minecraft/scenarios --jobs 2 --repeat 1; exits 1 on a red or cancelled scenario
```

Build the highlighter from the installed dependency and open the spectator:

```bash
bun run scenarios:spectator
```

After building once, `bunx --bun mine-labs run tests/minecraft/scenarios --spectator`
opens the same viewer directly. `spectator.mods` paths belong to the template
declaring them; Mine Labs loads their union for the entire catalog. Changing mods
or their JVM properties requires restarting the viewer. **O** toggles block
highlights; **N** toggles paths. The mod follows reconnects using
`blockhighlighter.serverPortOffset: "10000"`, matching this host's feed mapping.
Both overlays are enabled by default and their preferences persist.
