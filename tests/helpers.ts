/**
 * Shared helpers for the pi-handover test suite.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a unique temp directory (cleaned up by the OS). */
export function makeTempDir(prefix = "pihandover-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** The four required sections, in required order (SPEC §2.1). */
export const REQUIRED_SECTIONS = [
	"## Mission",
	"## What has been done",
	"## What we have learned",
	"## What is next",
] as const;

/** Assert the document contains the four required sections, in order. */
export function sectionIndices(doc: string): number[] {
	let cursor = -1;
	const indices: number[] = [];
	for (const section of REQUIRED_SECTIONS) {
		const index = doc.toLowerCase().indexOf(section.toLowerCase(), cursor + 1);
		if (index < 0) throw new Error(`missing section "${section}"`);
		indices.push(index);
		cursor = index;
	}
	return indices;
}

/** A well-formed handover document for stubbing the writer model. */
export function sampleDoc(title = "Test Mission", word = "banana"): string {
	return [
		`# Handover — ${title} (2026-01-01)`,
		"",
		"## Mission",
		`Secret project word: ${word}.`,
		"",
		"## What has been done",
		"- Verified: received the operation log.",
		"",
		"## What we have learned",
		"- The user expects exact acknowledgement strings.",
		"",
		"## What is next",
		"1. Acknowledge the second log.",
	].join("\n");
}
