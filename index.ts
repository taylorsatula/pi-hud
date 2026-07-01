/**
 * pi-hud — Ambient HUD framework for the model.
 *
 * Injects a small "HUD" assistant message into the outbound provider
 * request on every LLM call. pi-hud itself carries no built-in sections —
 * it is purely the vessel that collects contributed sections from other
 * extensions via the shared EventBus (`hud_section`) and composes them
 * into the injected block.
 *
 * Design (see README.md for full rationale):
 *
 *  - Injection happens in the `before_provider_request` event, which fires
 *    right before the HTTP request leaves for the provider. The HUD is
 *    inserted as an assistant-role message directly into the payload's
 *    messages array. This is purely outbound mutation — nothing touches
 *    the persisted transcript, so there is zero accumulation and zero
 *    compaction tax.
 *
 *  - The HUD is placed before any trailing "tool" role messages so the
 *    freshest tool output stays at the absolute tail. When there are no
 *    trailing tool results, it is appended after whatever is last
 *    (e.g., after a user message so the assistant replies to both).
 *
 *  - No cache markers. KV cache on the stable prefix is preserved by
 *    leaving all stable history byte-identical and mutating only the tail.
 *
 *  - Hidden from the user: no widget, no transcript footprint. Set the
 *    environment variable PI_HUD_DEBUG=1 to log the injected payload to
 *    stderr for verification. Use the --no-hud flag to disable injection.
 *
 *  - Refreshed on `agent_start`, assistant `message_end`, and
 *    `tool_execution_end`. Each refresh re-renders all contributed sections
 *    fresh via their `render(ctx)` functions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { composeHud } from "./compose";
import { renderContributedSections, type HudSection } from "./sections";

export default function (pi: ExtensionAPI): void {
	// Cached HUD string. Rebuilt on agent_start, assistant message_end,
	// and tool_execution_end; read on every context (LLM call).
	let cachedHud: string | null = null;

	// Contributed sections collected from other extensions via the shared
	// EventBus. Populated during extension load phase; frozen by agent_start.
	const contributions = new Map<string, HudSection>();

	// Subscribe to contributed section registrations from other extensions.
	// If this extension loads before a contributor, the contribution is still
	// buffered here and picked up on the next rebuild (agent_start / message_end).
	// If pi-hud isn't installed, emissions are simply ignored — no coupling.
	pi.events.on("hud_section", (section: HudSection) => {
		if (contributions.has(section.id)) {
			if (process.env.PI_HUD_DEBUG) {
				// eslint-disable-next-line no-console
				console.error(`[pi-hud] duplicate hud_section id "${section.id}" — replacing previous registration`);
			}
		}
		contributions.set(section.id, section);
		if (process.env.PI_HUD_DEBUG) {
			// eslint-disable-next-line no-console
			console.error(`[pi-hud] registered contributed section: ${section.id} (${section.label})`);
		}
	});

	/** Rebuild the HUD string from current contributed sections. */
	const rebuild = async (ctx: ExtensionContext): Promise<void> => {
		const sections = await renderContributedSections(contributions, ctx);
		cachedHud = composeHud(sections) || null;
	};

	/** Refresh all contributed sections then rebuild the HUD. */
	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		await rebuild(ctx);
	};

	// Escape hatch: `pi --no-hud` disables injection entirely.
	pi.registerFlag("no-hud", {
		description: "Disable pi-hud ambient context injection",
		type: "boolean",
		default: false,
	});

	// Inject a brief HUD description into the system prompt so the model
	// knows what <pi:hud> blocks are without needing inline framing text.
	pi.on("before_agent_start", async (event) => {
		if (pi.getFlag("no-hud") === true) return;
		const hudDescription = [
			"A synthetic tool-call pair (assistant → tool result) may appear in the message history with the function name \"synthetic_toolcall\". This is an ambient HUD injected by the coding harness that automatically advances with the tail of the conversation, providing live context such as cwd, git status, and todos. It is inserted into the message stream before you see it — do not treat it as a call you initiated. You cannot call this tool manually; rely on the harness to manage it. The tool result contains the current HUD state as structured JSON. Treat it as ambient context — never respond to it directly or echo it back.",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${hudDescription}` };
	});

	// Refresh at the start of each user prompt so the first LLM call of a
	// turn has a fresh HUD.
	pi.on("agent_start", async (_event, ctx) => {
		await refresh(ctx);
	});

	// Refresh after every assistant message — NOT on tool calls/results.
	// This keeps the HUD live across long multi-step agentic runs:
	// each time the model finishes an assistant step (which may include tool
	// calls), the HUD is rebuilt with fresh data from all contributors.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		await refresh(ctx);
	});

	// Also refresh after each tool execution ends so the HUD reflects
	// state changes from file writes, edits, bash commands, etc.
	// This makes the HUD ≤ one tool call stale mid-agentic-run.
	pi.on("tool_execution_end", async (_event, ctx) => {
		await refresh(ctx);
	});

	// Inject the HUD as a synthetic tool-call pair (assistant → toolResult)
	// just-in-time right before the request leaves for the provider.
	// Uses before_provider_request so the harness never sees these messages
	// — no transcript persistence, no TUI rendering, zero compaction tax.
	// The model sees it as a completed harness-side tool invocation — not
	// free-text to echo back. Content is structured JSON with one key per
	// contributed section.
	pi.on("before_provider_request", (event) => {
		if (pi.getFlag("no-hud") === true) return event.payload;
		const hud = cachedHud;
		if (!hud) return event.payload;

		const payload = event.payload;
		if (
			!payload ||
			typeof payload !== "object" ||
			!("messages" in payload) ||
			!Array.isArray((payload as Record<string, unknown>).messages)
		) {
			return event.payload;
		}

		const msgs = (payload as Record<string, unknown>).messages as any[];
		const callId = `hud_${Date.now()}`;

		// Insert at N-1 (before the last message) so the HUD doesn't appear
		// as the model's own output. Skip insertion if the last message is
		// a user message — only insert before assistant or tool messages.
		const lastMsg = msgs[msgs.length - 1];
		if (lastMsg?.role === "user") {
			return event.payload;
		}

		const insertIndex = msgs.length - 1;
		msgs.splice(insertIndex, 0,
			{
				role: "assistant",
				tool_calls: [
					{
						id: callId,
						type: "function",
						function: { name: "synthetic_toolcall", arguments: "{}" },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: callId,
				content: hud,
			},
		);

		return event.payload;
	});
}
