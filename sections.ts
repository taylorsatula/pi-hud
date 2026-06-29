/**
 * HUD section renderers.
 *
 * Each section is a small pure function that returns a string line, or null
 * when the section has nothing useful to show (e.g. not a git repo, or
 * context usage unavailable). The composer drops nulls, so empty sections
 * never produce empty headers in the HUD.
 *
 * Sections that need expensive data (git) take it as input rather than
 * fetching it themselves, so the fetch can be batched once per refresh and
 * the renderers stay trivial.
 *
 * Contributed sections (from other extensions via the shared EventBus)
 * follow the same contract: async render returning string | null.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

// ── Contributed section types ────────────────────────────────────────

/** A HUD section contributed by another extension via the EventBus. */
export interface HudSection {
	/** Unique key — prevents duplicate registrations (last wins). */
	id: string;
	/** Label shown before the rendered value, e.g. "Memory", "Tasks". */
	label: string;
	/**
	 * Render function called fresh on every HUD rebuild.
	 * Return a string to include the line, or null to omit it.
	 * May be async (file reads, API calls, etc.).
	 */
	render(ctx: ExtensionContext): Promise<string | null> | string | null;
}

/** Timeout for individual contributed section renders (ms). */
const RENDER_TIMEOUT_MS = 2_000;

export interface GitInfo {
	branch: string;
	dirty: number;
}

/**
 * Fetch git branch + dirty count in a single `git status --porcelain=v1 -b`.
 * Fault-tolerant: returns null if cwd is not a git repo, git is missing, or
 * the call times out. Never throws.
 */
export async function fetchGit(
	pi: ExtensionAPI,
	cwd: string,
): Promise<GitInfo | null> {
	try {
		const res = await pi.exec("git", ["status", "--porcelain=v1", "-b"], {
			cwd,
			timeout: 2000,
		});
		// 128 = "not a git repository" (and similar fatal errors)
		if (res.code !== 0) return null;

		const lines = res.stdout.split("\n").filter((l) => l.length > 0);
		if (lines.length === 0) return null;

		const branchLine = lines[0] ?? "";
		let branch = branchLine;
		if (branch.startsWith("## ")) {
			// e.g. "## main" or "## main...origin/main [ahead 1]"
			branch = branch.slice(3).split("...")[0].trim();
		}
		if (!branch || branch === "No commits yet") branch = "(no commits)";

		// First line is the branch line; the rest are changed files.
		const dirty = Math.max(0, lines.length - 1);
		return { branch, dirty };
	} catch {
		return null;
	}
}

/** Current date/time with timezone, unambiguous for a model. */
export function renderClock(): string {
	// toLocaleString with full date + long time includes the timezone name.
	return `Time: ${new Date().toLocaleString("en-US", {
		dateStyle: "full",
		timeStyle: "long",
	})}`;
}

/** Context budget from pi's live usage estimate. */
export function renderBudget(ctx: ExtensionContext): string | null {
	const usage = ctx.getContextUsage();
	if (!usage) return null;

	if (usage.tokens != null && usage.percent != null) {
		return `Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${usage.percent.toFixed(1)}%)`;
	}
	// tokens unknown (e.g. right after compaction, before next response)
	return `Context window: ${usage.contextWindow.toLocaleString()} tokens`;
}

/** Git branch + working-tree change count. */
export function renderGit(git: GitInfo | null): string | null {
	if (!git) return null;
	const state =
		git.dirty > 0
			? `· ${git.dirty} change${git.dirty === 1 ? "" : "s"}`
			: "(clean)";
	return `Git: ${git.branch} ${state}`;
}

/** Working directory, with $HOME collapsed to ~ for readability. */
export function renderCwd(cwd: string): string {
	const home = homedir();
	let display = cwd;
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
		display = `~${cwd.slice(home.length)}`;
	}
	return `CWD: ${display}`;
}

// ── Contributed section renderer ─────────────────────────────────────

/**
 * Render all contributed sections in parallel.
 * Each section is awaited independently with a timeout; errors are caught
 * per-section so one bad render doesn't kill the whole HUD.
 * Returns only non-null results, preserving registration order.
 */
export async function renderContributedSections(
	contributions: Map<string, HudSection>,
	ctx: ExtensionContext,
): Promise<string[]> {
	const results: string[] = [];
	const errors: Array<{ id: string; error: unknown }> = [];

	for (const [id, section] of contributions) {
		try {
			const timedRender = Promise.race([
				section.render(ctx),
				new Promise<null>((_, reject) =>
					setTimeout(() => reject(new Error(`hud_section "${id}" timed out after ${RENDER_TIMEOUT_MS}ms`)), RENDER_TIMEOUT_MS),
				),
			]);
			const value = await timedRender;
			if (value != null) {
				results.push(`${section.label}: ${value}`);
			}
		} catch (err) {
			errors.push({ id, error: err });
		}
	}

	if (errors.length > 0 && process.env.PI_HUD_DEBUG) {
		// eslint-disable-next-line no-console
		console.error(
			`[pi-hud] contributed section render errors:`,
			errors.map((e) => `${e.id}: ${String(e.error)}`).join("; "),
		);
	}

	return results;
}
