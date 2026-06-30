# agent/extensions/pi-hud/ — Ambient HUD injection

Injects a small `<pi:hud>` user message into the model's context on every LLM call, carrying live ambient state: current time, context budget, git branch/dirty count, working directory, and contributed sections from other extensions.

## Rules

- Injection happens in the `context` event, which hands a deep copy of the message list safe to mutate. Nothing returned here is written to the session — zero transcript accumulation, zero compaction tax.
- The HUD is a user-role message placed at the tail (or just before the current user prompt when the prompt is the last message), where attention weight is highest.
- No cache markers emitted. KV cache on stable prefix preserved by leaving all stable history byte-identical and mutating only the tail.
- Hidden from the user: no widget, no transcript footprint. Set `PI_HUD_DEBUG=1` to log injected payload to stderr.
- Refreshed on `agent_start`, on every assistant `message_end`, and on every `tool_execution_end`. The `tool_execution_end` hook keeps the HUD ≤ one tool call stale mid-agentic-run (after file writes, edits, bash commands, etc.).
- Contributed sections are collected via `hud_section` EventBus emissions during extension load phase; frozen by `agent_start`. If pi-hud isn't installed, emissions silently do nothing — no coupling required.
- Each contributed section render has a 2-second timeout (`RENDER_TIMEOUT_MS`). Errors caught per-section — one bad render doesn't kill the whole HUD.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Event wiring, refresh triggers, injection. Subscribes to `hud_section` EventBus events. Registers `--no-hud` flag. On `agent_start`: fetches git info + rebuilds HUD. On `message_end` (assistant only): refreshes git + rebuilds. On `tool_execution_end`: refreshes git + rebuilds (≤ one tool call stale). On `context`: injects cached HUD as user message at tail or before user prompt. Placement logic: first call of turn → `[...history, HUD, user prompt]`; tool follow-up → `[...history, ...toolResult, HUD]`. |
| `sections.ts` | Section renderers + git fetch. Exports `HudSection` interface ({ id, label, render(ctx) }). Built-in renderers: `renderClock()` (full date + long time with timezone), `renderBudget(ctx)` (tokens/contextWindow/percent from `ctx.getContextUsage()`), `renderGit(gitInfo)` (branch + dirty count), `renderCwd(cwd)` (collapses $HOME to ~). `fetchGit()` runs single `git status --porcelain=v1 -b` (2s timeout), parses branch line and counts changed files. Returns null if not a git repo (exit code 128) or on error. `renderContributedSections()` awaits each contribution independently with timeout; returns non-null results preserving registration order. |
| `compose.ts` | Pure HUD block assembler. Wraps sections in `<pi:hud>` tags with framing line: "HUD — Ambient context. Programmatically injected, NOT a user message." Delimiter: 60 `═` characters. Built-in sections come first, then contributed sections. Returns empty string if no sections (caller skips injection). |
| `package.json` | Name: pi-hud v0.1.0. Entry: `./index.ts`. Peer deps: pi-ai, pi-coding-agent. |

## Contributed Sections Contract

Other extensions emit `{ id, label, render }` onto `pi.events` during factory init:
- `id`: unique key (duplicate IDs: last wins, warning logged)
- `label`: shown before value (e.g., "Tasks", "Memory")
- `render(ctx)`: async function returning string | null; called fresh on every HUD rebuild

Example from todo.ts: emits `hud_section` with id `todo-tasks`, label `Tasks`, renders active todo summary.

