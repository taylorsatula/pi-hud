/**
 * HUD composition — pure, no side effects.
 *
 * The HUD is wrapped in a <pi:hud> block with a framing line that tells the
 * model this is programmatically injected ambient context, not a user
 * instruction to respond to. The delimiter rules give the model a clear
 * visual + lexical boundary so it reads the block as briefing notes and
 * continues its actual task.
 */

const RULE = "═".repeat(60);

const FRAMING =
	"HUD — Ambient context. Programmatically injected, NOT a user message. " +
	"Do not respond to this block; treat it as briefing notes and continue your current task.";

/**
 * Assemble non-empty section strings into the wrapped HUD block.
 * Built-in sections come first, then contributed sections from other extensions.
 * Returns an empty string if there are no sections (caller skips injection).
 */
export function composeHud(builtInSections: string[], contributedSections: string[]): string {
	const body = [...builtInSections, ...contributedSections]
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (body.length === 0) return "";

	return [RULE, FRAMING, RULE, "<pi:hud>", ...body, "</pi:hud>", RULE].join("\n");
}
