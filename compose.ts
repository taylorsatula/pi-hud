/**
 * HUD composition — pure, no side effects.
 *
 * Produces a compact JSON object mapping section labels to JSON-compatible values.
 */

import type { HudSectionValue } from "./sections";

/**
 * Serialize section data into a JSON string.
 * Returns an empty string if there are no sections (caller skips injection).
 */
export function composeHud(sections: Record<string, HudSectionValue>): string {
	if (Object.keys(sections).length === 0) return "";
	return JSON.stringify(sections);
}
