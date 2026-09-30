/**
 * TUI display of the handover document.
 *
 * pi renders every compaction — including ours — as a collapsible
 * `[compaction]` block, but collapsed to a single generic line that is easy
 * to miss. To make the handover discoverable in the chat transcript, the
 * extension appends a TUI-only custom entry right after each handover
 * compaction and renders it as a labeled `[handover]` block that mirrors
 * pi's compaction-summary component (same colors, same collapse semantics,
 * ctrl+o to expand). Custom entries never enter the LLM context, so the
 * display is free: the document itself still reaches the model through the
 * compaction summary.
 */

import { Box, Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { extractTitle } from "./handover.ts";

/** Custom-entry type name for the TUI-only handover block. */
export const HANDOVER_ENTRY_TYPE = "handover";

export interface HandoverEntryData {
	doc: string;
	title: string;
	/** Path of the persisted timestamped handover file. */
	file?: string | undefined;
	tokensBefore?: number | undefined;
}

/** Build the custom-entry payload from a compaction entry. */
export function createHandoverEntryData(
	doc: string,
	file?: string,
	tokensBefore?: number,
): HandoverEntryData {
	return { doc, title: extractTitle(doc), file, tokensBefore };
}

/** Structural slice of pi's Theme used by the renderer (method syntax → bivariant). */
interface RenderTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
}

/**
 * Render the `[handover]` block, mirroring pi's CompactionSummaryMessageComponent:
 * collapsed → title + file + expand hint; expanded → full document markdown.
 */
export function renderHandoverEntry(
	entry: { data?: HandoverEntryData | undefined },
	options: { expanded: boolean },
	theme: RenderTheme,
): Component | undefined {
	const { doc, title, file, tokensBefore } = entry.data ?? {};
	if (!doc) return undefined;

	const displayTitle = title ?? "Handover";
	const content = new Container();
	const label = theme.fg("customMessageLabel", `\x1b[1m[handover]\x1b[22m`);
	content.addChild(new Text(label, 0, 0));
	content.addChild(new Spacer(1));

	if (options.expanded) {
		const header = tokensBefore
			? `**Handover document** (compacted from ${tokensBefore.toLocaleString()} tokens)\n\n`
			: "**Handover document**\n\n";
		content.addChild(
			new Markdown(header + doc, 0, 0, getMarkdownTheme(), {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	} else {
		let line = theme.fg("customMessageText", displayTitle);
		if (file) line += theme.fg("dim", ` — ${file}`);
		// Matches pi's own hint (keybinding app.tools.expand, default ctrl+o).
		line += theme.fg("dim", " (ctrl+o to expand)");
		content.addChild(new Text(line, 0, 0));
	}

	const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
	box.addChild(content);
	return box;
}
