# agents — the brain layer (L3)

Characters that play through mine-ai-mcp bots. Players talk to them in **plain language** — no command words, no
syntax; voice input later — and LLMs work out what is meant and which basic functions (**skills**) to run with the
bot's atomic actions. No runtime internals are imported: everything goes through MCP (ADR-002). The brain shape is
ADR-008 and ADR-011 in `.agent/vision/decisions.md`; Rule #0 applies: code gives basic functions, settings and
safety checks, the models decide.

## How it thinks

1. **Init prompt** (`personaPrompt`, from the persona file): identity, traits, voice, stance as a disposition, its
   building style, its own `goal`, and its `authority` order (e.g. `["Server", "Tom", "*"]`: whose requests come
   first). It decides how to do things and may say a request is unclear, impossible, or that it does not know how.
2. **Chat tier** (fast model, in character): hears every chat line from players it listens to, answers right away,
   and routes it: `ignore` (not for me — no name needed), `talk`, `stop`, or `act` (it takes the request on),
   restating the request in one standalone sentence. Whether to accept is its call, guided by the init prompt.
3. **Objective stack**: what it takes on goes on top; whatever was running is set aside (its step stops) and resumes
   afterwards. `stop` clears the stack and it rests `settings.restAfterStopSeconds` before its own goal again.
4. **Work tier** (action model): one step at a time towards the top objective. Each call sees the situation, the
   objective and who asked, what was set aside, and the last steps with their outcomes; it answers a step, `done`
   or `give_up` (why). Code runs the step and feeds the result back; the chat tier narrates how an order ended.
5. **Goal tier** (planner model): with nothing to do, picks the next concrete objective towards its own goal, at most
   `settings.goalCallsPerMinute` model calls a minute for its own work (orders and chat are never held back).
6. **Settings the runtime keeps**: `settings.digStraightDown` (default false: routes descend by staircase), set on the
   runtime's survival policy at start and again whenever a snapshot shows it reset (death, dimension change).

Skills (`src/actions.ts`): follow a player, go to a player, go to coordinates, collect blocks, give items, craft
(intermediates automatic), get items (fetch like a player, then come back), eat, equip, sleep, hunt mobs for drops,
build a house (small or medium, always in the persona's own style, from carried blocks). A persona may limit them
(`skills`). A new skill = one catalog entry + one runner in `src/skills.ts`; the prompts are generated from the
catalog.

**Building** (`src/building/`, ADR-010): a style is a JSON palette (`styles/<id>.json`: block per material role +
roof type) fed to a parametric generator (`house.ts`). The house skill line in the prompt lists what the persona's
style needs; the model fetches it with `get_items` (`src/gathering.ts`: chop the logs, craft a crafting table to
carry and a wooden pickaxe when stone is needed, dig the stone, craft planks, fences and doors; the runtime's
`view_crafting_requirements` picks the recipes; each round restarts from the real inventory; crafting happens back
where it started), then builds where it stands, its door facing whoever asked: one `build_structure` call per layer,
a clearing pass that re-digs the room (navigation scaffolding), and the door last. The site is not surveyed.
A finished house becomes a **known place** (door and facing, a standing spot on the roof ridge): the agent keeps the
last 8 and every tier sees them in its situation ("Places you know: ..."), so "go to the roof" is a `go_to` with real
coordinates. When no skill fits a request (a pillar, a tower...), the prompts let the character say it does not know
how or ask what is meant; nothing in code lists what to refuse.

## Run

WSL, with a server and one host per bot running (`.agent/scripts/start-server.sh`, `start-host.sh`):

```bash
BOT_NAME=Ayla LISTEN_PORT=25575 .agent/scripts/start-host.sh      # terminal 1 (per bot)
bun run agents --agent agents/personas/ayla.json=http://127.0.0.1:25575/mcp   # terminal 2
# more agents, one process:  --agent agents/personas/vex.json=http://127.0.0.1:25576/mcp
```

Then just talk: "hey Ayla, stick with me", "could you grab me some wood?", "make me a crafting table",
"build me a house here", "ok you can stop now", or whisper `/msg Ayla ...`.

To try one skill on a live bot without any LLM:

```bash
bun agents/src/try-skill.ts http://127.0.0.1:25575/mcp '{"skill":"build","size":"small"}' --style japanese [--requester Steve]
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
`--action-model` and `--planner-model` override everything. `bun run agents --help` lists all of it.

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
| `styles/*.json` | Style palettes (material role → block) and house options |
| `src/try-skill.ts` | Dev CLI: run one catalog step on a live bot, no LLM |
| `src/say.ts` | Dev CLI: make another bot host say a chat line (a scripted player for live tests) |
| `src/gathering.ts` | Gather and craft items like a player (`get_items` skill) |
| `src/body.ts` | Owns the bot's single foreground slot: serialises actions; speech runs beside them at a typing pace |
| `src/runtime-client.ts` | Typed MCP client for one bot |
| `src/chat-model.ts` | OpenAI-compatible `/chat/completions` client |

Tests: `bun test ./agents` (scripted fake models and a fake runtime, no server, no LLM). Known limits and next
steps: `.agent/vision/backlog.md`.
