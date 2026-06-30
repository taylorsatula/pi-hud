/**
 * HUD composition — pure, no side effects.
 *
 * The HUD is wrapped in <pi:hud> tags. No framing line or delimiters —
 * just the tag boundary and the section lines.
 */

/**
 * Assemble non-empty section strings into the wrapped HUD block.
 * Sections come from extensions contributing via the hud_section EventBus.
 * Returns an empty string if there are no sections (caller skips injection).
 */
export function composeHud(sections: string[]): string {
	const body = sections
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (body.length === 0) return "";

	return ["<pi:hud>", ...body, "</pi:hud>"].join("\n");
}
