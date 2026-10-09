# agents — the brain layer (L3)

Characters that play through mine-ai-mcp bots. Players talk to them in **plain language** — no command words, no
syntax; voice input later — and LLMs work out what is meant and which basic functions (**skills**) to run with the
bot's atomic actions. No runtime internals are imported: everything goes through MCP (ADR-002). The brain shape is
ADR-008 and ADR-011 in `.agent/vision/decisions.md`; Rule #0 applies: code gives basic functions, settings and
safety checks, the models decide.

## How it thinks

1. **Init prompt** (`personaPrompt`, from the persona file): identity, traits, its `preferences` (ADR-015: one
   activity it loves, one it likes, one it dislikes, one it hates, as "You love farming and like building; you dislike
   fighting monsters and hate mining…": a feeling, never a switch), voice, stance as a disposition, its
   building style, its own `goal`, and its `authority` order (e.g. `["Server", "Tom", "*"]`: whose requests come
   first). Its own goal always gives way to any player's request; the authority order only ranks players against
   whoever it is already working for. It decides how to do things and may say a request is unclear, impossible, or
   that it does not know how.
2. **Chat tier** (fast model, in character): hears every chat line from players it listens to, answers right away,
   and routes it: `ignore` (clearly for someone else — a message naming nobody is for it), `talk`, `stop`, `act`
   (it takes the request on now) or `later` (only when the player says it can wait, or while it works for someone
   ranked above them), restating what the player asked in one standalone
   sentence. Whether to accept, and when, is its call, guided by the init prompt.
3. **Objective stack**: what it takes on now goes on top; whatever was running is set aside (its step stops) and
   resumes afterwards; `later` goes just below the top, but only behind work done for someone: over its own goal a
   player's request always goes on top (owner rule; the model answered `later` anyway once). `stop` clears the stack and it rests
   `settings.restAfterStopSeconds` before its own goal again.
4. **Work tier** (action model): one step at a time towards the top objective. Each call sees the situation, the
   objective and who asked, what was set aside, and the last steps with their outcomes; it answers a step, `done`
   or `give_up` (why). Code runs the step and feeds the result back; the chat tier narrates how an order ended. The
   same step ending the same way `settings.maxSameStepInARow` times in a row (default 3) ends the objective as
   failed, so a model that keeps retrying never spins until the step cap.
5. **Goal tier** (planner model): with nothing to do, picks the next concrete objective towards its own goal, at most
   `settings.goalCallsPerMinute` model calls a minute for its own work (orders and chat are never held back). It
   also sees **things that could use doing** (`src/opportunities.ts`: a tool nearly worn out, little food carried, a
   farm left a while, an unfinished house, no house of its own and what one still needs, no bed; at most 6, each
   tagged with its kind of work) and **how it spent the last hour** by activity; it weighs them with its tastes and
   may ignore them all.
6. **Settings the runtime keeps**: `settings.digStraightDown` (default false: routes descend by staircase), set on the
   runtime's survival policy at start and again whenever a snapshot shows it reset (death, dimension change).
7. **Time per activity** (`src/activities.ts`, `src/time-spent.ts`): every finished step has a kind of work
   (building, farming, mining, woodcutting, digging, foraging, hunting, mob combat, exploring, crafting, cooking…),
   from its skill and game data: what `collect_block` breaks by the game's block tags (`logs`, `mineable/pickaxe`,
   `mineable/shovel`, from `view_blocks` kinds), a hunt by the mob's hostile category, making a food is cooking; a
   `get_items` step is what its body spent most time on. Its minutes are counted (and remembered, `activity_time`).
8. **Memory** (`src/memory.ts`): known places, how its own last objectives ended and the unfinished house are saved
   as runtime notes (`note_save`, context `brain memory: <kind> {json}`) in the world's bot data, and read back with
   one `query_bot_data` when the brain starts, so a restart forgets nothing of these. The monitor lists them with
   the other notes. Orders in progress are not resumed after a restart.

Skills (`src/actions.ts`): follow a player, go to a player, go to coordinates, collect blocks, give items, craft
(intermediates automatic), get items (fetch that many more like a player, keeping everything it already carries, then
come back), eat, equip, sleep, hunt
mobs for drops, protect an area (never dig or place blocks within a radius of a player or a spot, e.g. when asked to
respect a build) and release it, build a house (small or medium, always in the persona's own style, from carried
blocks), make a crop farm or tend one it made (below). A persona
may limit them (`skills`). A new skill = one catalog entry + one runner in `src/skills.ts`; the prompts are generated
from the catalog.

**Building** (`src/building/`, ADR-010): a style is a JSON palette (`building-styles/<id>.json`: block per material role +
roof type, plus `variants`: the stairs and slab of a role) fed to a parametric generator (`house.ts`): stair roofs
facing up their slope with a slab ridge, pillars standing and trim beams along the walls (block states, ADR-013; a
style without variants builds a stepped roof). The house skill line in the prompt lists what the persona's
style needs; the model fetches it with `get_items` (`src/gathering.ts`: chop the logs, craft a crafting table to
carry and a wooden pickaxe when stone is needed, dig the stone, craft planks, fences and doors, smelt in a carried
furnace what only a furnace makes: glass for the panes, with the sand, the fuel and the furnace gathered or crafted
first; the runtime's `view_crafting_requirements` and `view_smelting_recipes` pick the recipes from game data; each
round restarts from the real inventory; crafting and smelting happen back where it started), then builds where it stands, its door facing whoever asked: one `build_structure` call per layer,
a clearing pass that re-digs the room (navigation scaffolding), and the door last. Before the first block it
levels its site (`src/building/terrain.ts`: holes under the floor filled from the bottom up, everything above it dug
from the top down, water displaced first, with the right tool for every block it digs: stone tools when it can spare
the cobblestone, else wood); every later part keeps what the earlier parts built (`build_structure` `keep`), and a
final pass checks every part again. The `level_area` skill uses the same engine on request: between the players'
marker blocks, around a player, or between corners, at most 32 by 32. The site is not surveyed. A house
left unfinished (a refused cell, the step set aside) is resumed at the same site and part by the next build step.
Before its first block the house protects its own box (cells + a one-block ring + the layer below, ADR-012), so the
character's own gathering and goals never dig into it; the build itself still works inside. Protected areas are read
at start (`protected_regions`) and every tier sees them ("Protected areas ...").
A finished house becomes a **known place** (door and facing, a standing spot on the roof ridge): the agent keeps the
last 8 and every tier sees them in its situation ("Places you know: ..."), so "go to the roof" is a `go_to` with real
coordinates. When no skill fits a request (a pillar, a tower...), the prompts let the character say it does not know
how or ask what is meant; nothing in code lists what to refuse.

**Farming** (`src/farming/`, ADR-014): `farm` makes a square plot (3-9 a side, 9 by default) right behind the character,
away from whoever asked (or around given coordinates): protected (`farm <crop>`), leveled with the house's site
engine (the middle cell left alone), water poured in the middle from a bucket it fills at the nearest water (or one it
carries; water already there is kept), then the runtime's `tend_crops` tills and plants it. Missing a hoe, the crop
item or a bucket, the step fails naming the `get_items` step to take. Near one of its farms (8 blocks from the
middle) `farm` tends it instead: ripe crops harvested (ripeness from the game's loot tables) and replanted with their
own seed, the asked crop planted on empty farmland when carried. Each farm is remembered (`brain memory: farm`) as it
was at its last tend and every tier sees it as a known place ("your wheat_seeds farm …, tended 14 min ago"); when to
come back is the model's choice.

## Run

Characters are not shipped with the code: write one per character as `personas/<id>.json` at the repository root
(schema: `personaSchema` in `src/persona.ts`).

WSL, with a server and one host per bot running (`.agent/scripts/start-server.sh`, `start-host.sh`):

```bash
BOT_NAME=Ayla LISTEN_PORT=25575 .agent/scripts/start-host.sh      # terminal 1 (per bot)
bun run brain --agent personas/ayla.json=http://127.0.0.1:25575/mcp   # terminal 2
# more agents, one process:  --agent personas/vex.json=http://127.0.0.1:25576/mcp
```

Then just talk: "hey Ayla, stick with me", "could you grab me some wood?", "make me a crafting table",
"build me a house here", "ok you can stop now", or whisper `/msg Ayla ...`.

To try one skill on a live bot without any LLM:

```bash
bun brain/src/try-skill.ts http://127.0.0.1:25575/mcp '{"skill":"build","size":"small"}' --style japanese [--requester Steve]
```

## LLM configuration

An LLM is required (there is no offline keyword mode). Any OpenAI-compatible endpoint works (OpenAI, OpenRouter,
Groq, Mistral, Ollama, LM Studio...). Put the settings in a `.env` at the repo root (gitignored):

```bash
MINE_AI_LLM_BASE_URL=https://openrouter.ai/api/v1   # or http://127.0.0.1:11434/v1 for Ollama
MINE_AI_LLM_API_KEY=...                              # never commit it
MINE_AI_LLM_MODEL=<default model id for every tier>
# Optional per tier (CHAT, ACTION, PLANNER): model, and even a different provider
MINE_AI_LLM_CHAT_MODEL=<small fast model>
MINE_AI_LLM_PLANNER_MODEL=<stronger model>
MINE_AI_LLM_CHAT_BASE_URL=...   MINE_AI_LLM_CHAT_API_KEY=...
MINE_AI_LLM_JSON_MODE=true      # false if the provider rejects response_format json_object
MINE_AI_LLM_TIMEOUT_MS=30000
```

A persona may pin its own models (`"models": {"chat": "...", "planner": "..."}`); `--chat-model`,
`--action-model` and `--planner-model` override everything. `bun run brain --help` lists all of it.

## Layout

| File | Role |
|---|---|
| `src/main.ts` | CLI: personas × MCP URLs → agents; tier models from CLI/persona/env |
| `src/persona.ts` | Persona schema (ADR-004/005/011): goal, authority, skills, settings |
| `src/agent.ts` | Chat handling, objective stack, work loop, own-goal pacing, settings kept on the runtime |
| `src/mind.ts`, `llm-mind.ts` | Chat, work and goal tiers + narration, init prompt, JSON repair round |
| `src/actions.ts` | Skill catalog: step schemas and prompt lines |
| `src/skills.ts` | Step executor over atomic actions (following = repeated `navigate`) |
| `src/building/` | Blueprint schema, rotation, bill of materials, batching; house generator; styles loader; site plan |
| `building-styles/*.json` | Style palettes (material role → block) and house options |
| `src/try-skill.ts` | Dev CLI: run one catalog step on a live bot, no LLM |
| `src/say.ts` | Dev CLI: make another bot host say a chat line (a scripted player for live tests) |
| `src/gathering.ts` | Gather and craft items like a player (`get_items` skill) |
| `src/body.ts` | Owns the bot's single foreground slot: serialises actions; speech runs beside them at a typing pace |
| `src/runtime-client.ts` | Typed MCP client for one bot |
| `src/chat-model.ts` | OpenAI-compatible `/chat/completions` client |

Tests: `bun test ./brain` (scripted fake models and a fake runtime, no server, no LLM). Known limits and next
steps: `.agent/vision/backlog.md`.
