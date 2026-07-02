# pi-hud — Ambient HUD framework

Pure vessel for HUD injection: collects contributed sections from other extensions via the `hud_section` EventBus contract, composes them into structured JSON, and injects it as a synthetic tool result on every LLM call. Carries **no built-in sections** itself — those live in `@taylorsatula/pi-hud-builtinplugins`.

## Rules

- Injection happens in the `before_provider_request` event by mutating only the outbound provider payload. Nothing returned here is written to the session — zero transcript accumulation, zero compaction tax.
- The HUD is injected as a synthetic assistant tool call plus tool result immediately before the outbound payload's current tail message; empty payloads are left unchanged. Tool-call arguments list `{ request: "read_hud", format: "json_object_by_section_label", sections: [...] }`; tool-result content is the structured HUD JSON. On first calls, the current user prompt remains absolute tail and the HUD result is tail-1, so the model never sees the HUD as the final message.
- No cache markers emitted. KV cache on stable prefix preserved by leaving all stable history byte-identical and mutating only the tail.
- Hidden from the user: no widget, no transcript footprint. Set `PI_HUD_DEBUG=1` to log injected payload to stderr.
- Refreshed on `agent_start`, on every assistant `message_end`, every `tool_execution_end`, explicit EventBus `hud_refresh` invalidations, and deterministically in `before_provider_request` when the HUD dirty flag is set. Each refresh re-renders all contributed sections fresh via their `render(ctx)` functions.
- Contributed sections are collected via `hud_section` EventBus emissions during extension load phase; values may be strings or nested JSON-compatible objects/arrays. If pi-hud isn't installed, emissions silently do nothing — no coupling required.
- Each contributed section render has a 2-second timeout (`RENDER_TIMEOUT_MS`). Errors caught per-section — one bad render doesn't kill the whole HUD.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Event wiring, refresh triggers, injection. Subscribes to `hud_section` and `hud_refresh` EventBus events. Registers `--no-hud` flag. On `agent_start`, `message_end` (assistant only), `tool_execution_end`, `hud_refresh`, and dirty `before_provider_request`: re-renders all contributed sections + rebuilds HUD plus section labels. On `before_provider_request`: injects cached HUD as a synthetic assistant/tool pair immediately before the payload tail. |
| `sections.ts` | `HudSection` interface ({ id, label, render(ctx) }), `HudSectionValue` JSON-value type, and `renderContributedSections()`. Awaits each contribution independently with 2s timeout; errors caught per-section; returns non-null results preserving registration order and nested structured values. |
| `compose.ts` | Pure HUD JSON serializer. Returns empty string if no sections (caller skips injection). |
| `package.json` | Name: @taylorsatula/pi-hud v1.2.0. Entry: `./index.ts`. Peer deps: pi-agent-core, pi-ai, pi-coding-agent. |

## Contributed Sections Contract

Other extensions emit `{ id, label, render }` onto `pi.events` during factory init:
- `id`: unique key (duplicate IDs: last wins, warning logged)
- `label`: JSON key for the section (e.g., "Time", "Context", "Tasks", "Memory", "Pi Overwatch")
- `render(ctx)`: async function returning `HudSectionValue | null`; called fresh on every HUD rebuild

The built-in sections (clock, budget, git, cwd) are provided by `@taylorsatula/pi-hud-builtinplugins`, which registers itself via this same contract.

