# pi-hud — Ambient HUD framework

Pure vessel for HUD injection: collects contributed sections from other extensions via the `hud_section` EventBus contract, composes them into a wrapped `<pi:hud>` block, and injects it as a user message on every LLM call. Carries **no built-in sections** itself — those live in `@taylorsatula/pi-hud-builtinplugins`.

## Rules

- Injection happens in the `context` event, which hands a deep copy of the message list safe to mutate. Nothing returned here is written to the session — zero transcript accumulation, zero compaction tax.
- The HUD is a user-role message placed at the tail (or just before the current user prompt when the prompt is the last message), where attention weight is highest.
- No cache markers emitted. KV cache on stable prefix preserved by leaving all stable history byte-identical and mutating only the tail.
- Hidden from the user: no widget, no transcript footprint. Set `PI_HUD_DEBUG=1` to log injected payload to stderr.
- Refreshed on `agent_start`, on every assistant `message_end`, and on every `tool_execution_end`. Each refresh re-renders all contributed sections fresh via their `render(ctx)` functions.
- Contributed sections are collected via `hud_section` EventBus emissions during extension load phase; frozen by `agent_start`. If pi-hud isn't installed, emissions silently do nothing — no coupling required.
- Each contributed section render has a 2-second timeout (`RENDER_TIMEOUT_MS`). Errors caught per-section — one bad render doesn't kill the whole HUD.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Event wiring, refresh triggers, injection. Subscribes to `hud_section` EventBus events. Registers `--no-hud` flag. On `agent_start`, `message_end` (assistant only), and `tool_execution_end`: re-renders all contributed sections + rebuilds HUD. On `context`: injects cached HUD as user message at tail or before user prompt. Placement logic: first call of turn → `[...history, HUD, user prompt]`; tool follow-up → `[...history, ...toolResult, HUD]`. |
| `sections.ts` | `HudSection` interface ({ id, label, render(ctx) }) + `renderContributedSections()`. Awaits each contribution independently with 2s timeout; errors caught per-section; returns non-null results preserving registration order. |
| `compose.ts` | Pure HUD block assembler. Wraps sections in `<pi:hud>` tags with framing line: "HUD — Ambient context. Programmatically injected, NOT a user message." Delimiter: 60 `═` characters. Returns empty string if no sections (caller skips injection). |
| `package.json` | Name: @taylorsatula/pi-hud v0.1.0. Entry: `./index.ts`. Peer dep: pi-coding-agent. |

## Contributed Sections Contract

Other extensions emit `{ id, label, render }` onto `pi.events` during factory init:
- `id`: unique key (duplicate IDs: last wins, warning logged)
- `label`: shown before value (e.g., "Time", "Context", "Tasks", "Memory")
- `render(ctx)`: async function returning string | null; called fresh on every HUD rebuild

The built-in sections (clock, budget, git, cwd) are provided by `@taylorsatula/pi-hud-builtinplugins`, which registers itself via this same contract.

