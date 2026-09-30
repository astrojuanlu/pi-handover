/**
 * Unit tests for the TUI display module (extensions/display.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createHandoverEntryData, renderHandoverEntry, HANDOVER_ENTRY_TYPE } from "../extensions/display.ts";
import { sampleDoc } from "./helpers.ts";

const passthroughTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
};

test("createHandoverEntryData extracts the title and carries the file and token count", () => {
	const data = createHandoverEntryData(sampleDoc("Visibility Fix"), "/repo/.pi/handover.md", 240160);
	assert.equal(data.title, "Visibility Fix");
	assert.equal(data.file, "/repo/.pi/handover.md");
	assert.equal(data.tokensBefore, 240160);
	assert.ok(data.doc.startsWith("# Handover — Visibility Fix"));
});

test("createHandoverEntryData tolerates a missing file and token count", () => {
	const data = createHandoverEntryData(sampleDoc());
	assert.equal(data.file, undefined);
	assert.equal(data.tokensBefore, undefined);
	assert.equal(data.title.length > 0, true);
});

test("renderHandoverEntry renders collapsed and expanded without throwing", () => {
	initTheme("dark");
	const data = createHandoverEntryData(sampleDoc("Rendered"), "/repo/.pi/handover.md", 1000);
	const entry = { type: "custom", customType: HANDOVER_ENTRY_TYPE, data } as const;
	for (const expanded of [false, true]) {
		const component = renderHandoverEntry(entry, { expanded }, passthroughTheme);
		assert.ok(component, `component rendered (expanded=${expanded})`);
	}
});

test("HANDOVER_ENTRY_TYPE is a stable custom-entry type name", () => {
	assert.equal(typeof HANDOVER_ENTRY_TYPE, "string");
	assert.equal(HANDOVER_ENTRY_TYPE, "handover");
});
