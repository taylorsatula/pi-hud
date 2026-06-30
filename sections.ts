/**
 * HUD section types + contributed-section renderer.
 *
 * pi-hud is the vessel — it defines the contract and renders whatever
 * sections other extensions contribute. It carries no built-in sections
 * itself.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
