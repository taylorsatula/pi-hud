# pi-hud

A pi package extension that gives the model a live **ambient HUD** — a small briefing block injected into the model's context on every LLM call, carrying current time, context budget, git status, and working directory.

This is a port of the "HUD" pattern (see `botwithmemory`'s `<mira:hud>`), adapted to stock pi and stripped of its one expensive habit: persisting the HUD into the transcript. In pi, the HUD is **non-persistent** — it lives only in the per-call message copy and never enters stored history.

## What it does

- **Refreshes on assistant messages, not tool calls.** The HUD is rebuilt whenever an assistant message completes (and at the start of each user prompt). Because agentic runs produce one assistant message per step, the HUD stays current across long multi-step runs.
- **Injects on every LLM call** via the `context` event, which hands the extension a deep copy of the message list. The HUD is appended at the tail (or just before the current user prompt on the first call of a turn), where attention weight is highest.
- **Adds zero transcript clutter.** Nothing returned from `context` is written to the session. Old HUDs don't recede into history — they simply don't exist next call. There is no accumulation cost, no compaction tax, and no footprint the user has to wade through.
- **Is hidden from the user.** No widget, no transcript entry, nothing in the TUI. The HUD is exclusively for the model's ambient awareness. Set `PI_HUD_DEBUG=1` to log the injected payload to stderr for verification.

## The injected block

```
══════════════════════════════════════════════════════════
HUD — Ambient context. Programmatically injected, NOT a user message. Do not respond to this block; treat it as briefing notes and continue your current task.
══════════════════════════════════════════════════════════
<pi:hud>
Time: Sunday, June 29, 2026 at 2:51:07 PM Eastern Daylight Time
Context: 12,345 / 200,000 tokens (6.2%)
Git: main · 3 changes
CWD: ~/projects/foo
</pi:hud>
══════════════════════════════════════════════════════════
```

Empty sections (e.g. not a git repo) are omitted entirely.

## Placement

The HUD is a **user-role** message. Provider-legal everywhere, no role-order issues:

- **First LLM call of a turn** (tail is the user prompt): `[...history, HUD, user prompt]` — the HUD briefs the model immediately before the instruction it should respond to.
- **Tool follow-up** (tail is tool results): `[...history, user prompt, ...toolResult, HUD]` — the HUD sits at the tail as live context while the model decides its next step.

A framing line inside the block tells the model the HUD is injected ambient context, not an instruction to respond to, so a trailing user-role HUD during a tool follow-up reads as a briefing rather than a new turn.

## Cache

No cache markers are emitted. KV cache on the stable prefix is preserved by construction: the HUD mutates only the tail, leaving all stable history byte-identical. The HUD tokens are uncached by necessity (the content changes every refresh) — you can't both cache a block and have it update.

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

Other extensions can contribute their own HUD lines without depending on pi-hud directly. They emit a `hud_section` event on the shared EventBus; pi-hud collects it and renders it alongside its built-in sections.

### How it works

1. A contributing extension emits `{ id, label, render }` onto `pi.events` during its factory init.
2. pi-hud subscribes to that event and buffers contributions in a Map keyed by `id`.
3. On every HUD rebuild (`agent_start`, `message_end`), contributed sections are rendered fresh via their `render(ctx)` functions.
4. Contributed lines appear **after** built-in sections (time → context → cwd → git → contributed...).

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

The result appears in the HUD as:

```
Memory: 12 entries loaded
```

### Contract

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique key. Duplicate IDs: last wins (warning logged). |
| `label` | `string` | Shown before the value, e.g. `"Tasks"`, `"Network"`. |
| `render(ctx)` | `(ExtensionContext) => Promise<string \| null> \| string \| null` | Called fresh on every HUD rebuild. Return `null` to omit the line. May be async. |

### Error handling

- **Render throws**: caught per-section, line omitted, error logged (debug mode only). One bad section doesn't kill the whole HUD.
- **Slow async render**: 2-second timeout per section. Timed-out sections are omitted.
- **Duplicate IDs**: last registration wins; warning emitted to stderr in debug mode.

## Files

- `index.ts` — event wiring, refresh triggers, injection.
- `sections.ts` — section renderers + git fetch.
- `compose.ts` — pure HUD block assembler.
- `package.json` — pi manifest.

## Why no persistence

botwithmemory persists each turn's HUD as a real assistant message, so old HUDs recede into history ("prior states remain visible"). That costs a full HUD of tokens per turn until compaction folds them. In stock pi, `ctx.sessionManager` is read-only for extensions, so persistence isn't available anyway — but even where it is, non-persistent injection is the cleaner default: identical live-awareness benefit, zero accumulation. The "prior states visible" property is only worth the tax if the model actually consults stale HUDs, which is an open empirical question.
