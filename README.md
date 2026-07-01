# pi-hud

A pi package extension that provides the **ambient HUD framework** — a vessel for injecting a small briefing block into the model's context on every LLM call. pi-hud carries no built-in sections itself; all content comes from other extensions contributing via the shared EventBus.

This is a port of the "HUD" pattern (see `botwithmemory`'s `<mira:hud>`), adapted to stock pi and stripped of its one expensive habit: persisting the HUD into the transcript. In pi, the HUD is **non-persistent** — it lives only in the per-call message copy and never enters stored history.

## What it does

- **Refreshes on agent start, assistant messages, and tool execution end.** The HUD is rebuilt at the start of each user prompt, after every assistant message completes, and after each tool execution ends. This keeps the HUD ≤ one tool call stale mid-agentic-run.
- **Injects on every LLM call** via the `before_provider_request` event, which fires right before the HTTP request leaves for the provider. The HUD is inserted as a synthetic assistant/tool-call pair directly into the payload's messages array. This is purely outbound mutation — nothing touches the persisted transcript, so there is zero accumulation and zero compaction tax.
- **Adds zero transcript clutter.** Nothing returned from `before_provider_request` is written to the session. Old HUDs don't recede into history — they simply don't exist next call. There is no accumulation cost, no compaction tax, and no footprint the user has to wade through.
- **Is hidden from the user.** No widget, no transcript entry, nothing in the TUI. The HUD is exclusively for the model's ambient awareness. Set `PI_HUD_DEBUG=1` to log the injected payload to stderr for verification.

## The injected block

The HUD is injected as a synthetic assistant/tool-call pair — not free-text to echo back:

```
{ assistant: { tool_calls: [{ id: "hud_...", type: "function", function: { name: "__hud", arguments: "{\"Time\":\"...\",\"Context\":\"...\",\"CWD\":\"~\"}" } }] },
  tool:   { tool_call_id: "hud_...", content: "ok" } }
```

The `arguments` field contains structured JSON with one key per contributed section (label → value). Sections returning `null` are omitted entirely. If all sections return null, no HUD is injected.

## Placement

The HUD is always appended at the absolute tail of the messages array. It uses the assistant/tool role pair, which is provider-legal everywhere and avoids role-order issues.

No cache markers are emitted. KV cache on the stable prefix is preserved by construction: the HUD mutates only the tail, leaving all stable history byte-identical. The HUD tokens are uncached by necessity (the content changes every refresh) — you can't both cache a block and have it update.

## System prompt injection

The model understands what `<pi:hud>` blocks are because a brief description is injected into the system prompt on `before_agent_start` — no inline framing text needed in the HUD itself.

## Controls

| Flag | Effect |
|------|--------|
| `--no-hud` | Disable injection entirely. |

| Env | Effect |
|-----|--------|
| `PI_HUD_DEBUG=1` | Log the injected HUD payload to stderr before each LLM call. |

## Install

```bash
pi install /path/to/pi-hud
# or, for a quick test:
pi -e /path/to/pi-hud
```

As an auto-discovered project extension under `.pi/extensions/pi-hud/` it loads after project trust; `/reload` hot-reloads it.

## Contributing sections from other extensions

All HUD content comes from other extensions contributing via the shared EventBus. A contributing extension emits a `hud_section` event; pi-hud collects it and renders it on every HUD rebuild.

### How it works

1. A contributing extension emits `{ id, label, render }` onto `pi.events` during its factory init.
2. pi-hud subscribes to that event and buffers contributions in a Map keyed by `id`.
3. On every HUD rebuild (`agent_start`, `message_end`, `tool_execution_end`), each contributed section is rendered fresh via its `render(ctx)` function, processed sequentially in registration order.

If pi-hud isn't installed, emissions silently do nothing — no coupling required.

### Example

```ts
// In any extension's factory:
export default function(pi: ExtensionAPI): void {
  pi.events.emit("hud_section", {
    id: "memory-state",
    label: "Memory",
    async render(ctx) {
      const entries = await ctx.sessionManager.getCustomEntries("memory");
      if (!entries?.length) return null;
      return `${entries.length} entries loaded`;
    },
  });
}
```

The result appears in the HUD JSON as:

```json
{"Memory":"12 entries loaded"}
```

### Contract

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique key. Duplicate IDs: last wins (warning logged). |
| `label` | `string` | Shown as the JSON key, e.g. `"Memory"`, `"Tasks"`. |
| `render(ctx)` | `(ExtensionContext) => Promise<string \| null> \| string \| null` | Called fresh on every HUD rebuild. Return `null` to omit the line. May be async. |

### Error handling

- **Render throws**: caught per-section, line omitted, error logged (debug mode only). One bad section doesn't kill the whole HUD.
- **Slow async render**: 2-second timeout per section. Timed-out sections are omitted.
- **Duplicate IDs**: last registration wins; warning emitted to stderr in debug mode.

## Files

- `index.ts` — event wiring, refresh triggers, injection.
- `sections.ts` — `HudSection` interface + sequential renderer with per-section timeout.
- `compose.ts` — pure HUD block assembler (JSON serialization).
- `package.json` — pi manifest.

## Why no persistence

botwithmemory persists each turn's HUD as a real assistant message, so old HUDs recede into history ("prior states remain visible"). That costs a full HUD of tokens per turn until compaction folds them. In stock pi, `ctx.sessionManager` is read-only for extensions, so persistence isn't available anyway — but even where it is, non-persistent injection is the cleaner default: identical live-awareness benefit, zero accumulation. The "prior states visible" property is only worth the tax if the model actually consults stale HUDs, which is an open empirical question.
