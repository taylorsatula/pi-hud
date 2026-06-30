/**
 * pi-hud — Ambient HUD for the model.
 *
 * Injects a small "HUD" user message into the model's context on every LLM
 * call, carrying live ambient state: current time, context budget, git
 * branch/dirty, and working directory. The HUD is rebuilt whenever an
 * assistant message completes (and at the start of each user prompt), so it
 * stays current during long agentic runs.
 *
 * Design (see README.md for full rationale):
 *
 *  - Injection happens in the `context` event, which hands us a deep copy of
 *    the message list safe to mutate. Nothing returned here is written to
 *    the session, so there is zero transcript accumulation and zero cost to
 *    stored history. Old HUDs don't recede into history — they simply don't
 *    exist next call.
 *
 *  - The HUD is a user-role message placed at the tail (or just before the
 *    current user prompt when the prompt is the last message), where
 *    attention weight is highest. A framing line inside the block tells the
 *    model it is injected ambient context, not an instruction to respond to.
 *
 *  - No cache markers. KV cache on the stable prefix is preserved by leaving
 *    all stable history byte-identical and mutating only the tail.
 *
 *  - Hidden from the user: no widget, no transcript footprint. Set the
 *    environment variable PI_HUD_DEBUG=1 to log the injected payload to
 *    stderr for verification. Use the --no-hud flag to disable injection.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { composeHud } from "./compose";
import {
	fetchGit,
	renderBudget,
	renderClock,
	renderContributedSections,
	renderCwd,
	renderGit,
	type GitInfo,
	type HudSection,
} from "./sections";

export default function (pi: ExtensionAPI): void {
	// Cached state. Refreshed on agent_start and on every assistant
	// message_end; read on every context (LLM call).
	let cachedHud: string | null = null;
	let gitInfo: GitInfo | null = null;

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

	/** Rebuild the HUD string from current sections. Pure given the cache. */
	const rebuild = async (ctx: ExtensionContext): Promise<void> => {
		const builtInSections = [
			renderClock(),
			renderBudget(ctx),
			renderGit(gitInfo),
			renderCwd(ctx.cwd),
		].filter((s): s is string => Boolean(s));

		const contributedSections = await renderContributedSections(contributions, ctx);

		cachedHud = composeHud(builtInSections, contributedSections) || null;
	};

	/**
	 * Refresh expensive state (git) then rebuild the HUD.
	 * Runs on agent_start and on assistant message_end, so the HUD reflects
	 * state as of the most recent assistant message — "≤ one assistant
	 * message stale" even mid-aggentic-run.
	 */
	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		gitInfo = await fetchGit(ctx.cwd);
		await rebuild(ctx);
	};

	// Escape hatch: `pi --no-hud` disables injection entirely.
	pi.registerFlag("no-hud", {
		description: "Disable pi-hud ambient context injection",
		type: "boolean",
		default: false,
	});

	// Refresh at the start of each user prompt so the first LLM call of a
	// turn has a fresh HUD (clock advanced, git may have changed, etc.).
	pi.on("agent_start", async (_event, ctx) => {
		await refresh(ctx);
	});

	// Refresh after every assistant message — NOT on tool calls/results.
	// This is what keeps the HUD live across long multi-step agentic runs:
	// each time the model finishes an assistant step (which may include tool
	// calls), the HUD is rebuilt with fresh git state and a fresh clock.
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

	// Inject the cached HUD as a user message at the tail of every LLM call.
	pi.on("context", async (event) => {
		if (pi.getFlag("no-hud") === true) return;
		const hud = cachedHud;
		if (!hud) return;

		if (process.env.PI_HUD_DEBUG) {
			// eslint-disable-next-line no-console
			console.error(
				`[pi-hud] injecting HUD (${hud.length} chars) before LLM call:\n${hud}\n`,
			);
		}

		const hudMsg = {
			role: "user" as const,
			content: hud,
			timestamp: Date.now(),
		};

		const msgs = event.messages;
		const last = msgs[msgs.length - 1];
		let out;
		if (last && last.role === "user") {
			// First call of a turn: brief right before the user prompt so the
			// prompt remains the last message to respond to.
			out = [...msgs.slice(0, -1), hudMsg, last];
		} else {
			// Tool follow-up (tail is toolResult) or other: append at tail.
			out = [...msgs, hudMsg];
		}
		return { messages: out };
	});
}
