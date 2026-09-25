/**
 * Unit tests for the handover document: prompt assembly, validation,
 * title extraction, and file inventory (extensions/handover.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	HANDOVER_PROMPT,
	HANDOVER_PROMPT_VERSION,
	buildHandoverUserPrompt,
	extractTitle,
	formatFileInventory,
	validateHandoverDoc,
} from "../extensions/handover.ts";
import { REQUIRED_SECTIONS, sampleDoc } from "./helpers.ts";

const today = () => new Date().toISOString().slice(0, 10);

test("HANDOVER_PROMPT declares the four sections and is versioned", () => {
	assert.equal(typeof HANDOVER_PROMPT_VERSION, "number");
	for (const section of REQUIRED_SECTIONS) {
		assert.ok(HANDOVER_PROMPT.includes(section), `prompt must contain "${section}"`);
	}
	assert.ok(HANDOVER_PROMPT.includes("{maxWords}"), "prompt references the maxWords cap");
	assert.ok(HANDOVER_PROMPT.includes("ONLY facts"), "prompt enforces fact discipline");
});

test("validateHandoverDoc accepts a well-formed document", () => {
	const doc = validateHandoverDoc(sampleDoc());
	assert.ok(doc);
	assert.ok(doc.startsWith("# Handover — "));
	assert.ok(doc.includes("## Mission"));
});

test("validateHandoverDoc rejects incomplete or malformed documents", () => {
	assert.equal(validateHandoverDoc(""), null);
	assert.equal(validateHandoverDoc("# t\n\n## Mission\nonly one section"), null);
	const wrongOrder = ["## What is next", "## Mission", "## What has been done", "## What we have learned"]
		.map((s) => `${s}\ntext`)
		.join("\n\n");
	assert.equal(validateHandoverDoc(`# t\n\n${wrongOrder}`), null, "sections out of order");
});

test("validateHandoverDoc is deliberately lenient about duplicated headings", () => {
	// A duplicated heading is a cosmetic defect; rejecting the document would
	// fall back to default compaction, which loses far more than the duplicate.
	const duplicateOnly = `# t\n\n## Mission\na\n\n## Mission\nb\n\n## What has been done\nc\n\n## What we have learned\nd\n\n## What is next\ne`;
	assert.ok(validateHandoverDoc(duplicateOnly), "first occurrences in order still validate");
});

test("validateHandoverDoc strips a wrapping code fence", () => {
	const fenced = "```markdown\n" + sampleDoc() + "\n```";
	const doc = validateHandoverDoc(fenced);
	assert.ok(doc);
	assert.ok(doc.startsWith("# Handover"), "fence stripped");
});

test("validateHandoverDoc prepends a title heading when missing", () => {
	const body = ["## Mission\nm", "## What has been done\nd", "## What we have learned\nl", "## What is next\n1"].join("\n\n");
	const doc = validateHandoverDoc(body);
	assert.ok(doc);
	assert.ok(doc.startsWith(`# Handover (${today()})`));
});

test("validateHandoverDoc stamps the real UTC date over a model-hallucinated one", () => {
	const doc = validateHandoverDoc(sampleDoc("Old Date", "x").replace("(2026-01-01)", "(1999-12-31)"));
	assert.ok(doc);
	assert.ok(doc.startsWith(`# Handover — Old Date (${today()})`));
	assert.ok(!doc.includes("1999-12-31"), "hallucinated date replaced");
});

test("extractTitle reads the one-line task title from the heading", () => {
	assert.equal(extractTitle(sampleDoc("Fix the flaky test")), "Fix the flaky test");
	assert.equal(extractTitle("# no parenthesized date here\n\n## Mission"), "handover", "fallback title");
});

test("buildHandoverUserPrompt: first compaction has conversation but no base", () => {
	const prompt = buildHandoverUserPrompt({ conversation: "CONV", maxWords: 800 });
	assert.ok(prompt.includes("under 800 words"));
	assert.ok(prompt.includes("<conversation>\nCONV\n</conversation>"));
	assert.ok(!prompt.includes("base-handover"), "no base section without previousSummary");
});

test("buildHandoverUserPrompt: iterative compaction leads with the base handover", () => {
	const prompt = buildHandoverUserPrompt({
		conversation: "SINCE",
		previousSummary: "BASE",
		fileInventory: "FILES",
		extraInstructions: "EXTRA",
		maxWords: 500,
	});
	const baseIdx = prompt.indexOf("<base-handover>\nBASE\n</base-handover>");
	const sinceIdx = prompt.indexOf("<conversation-since>\nSINCE\n</conversation-since>");
	const filesIdx = prompt.indexOf("<file-inventory>\nFILES\n</file-inventory>");
	const extraIdx = prompt.indexOf("<extra-instructions>\nEXTRA\n</extra-instructions>");
	assert.ok(baseIdx >= 0, "base handover present");
	assert.ok(sinceIdx > baseIdx, "base handover comes first");
	assert.ok(filesIdx > 0 && extraIdx > 0);
	assert.ok(prompt.includes("never drop still-relevant content"), "merge instruction present");
});

test("buildHandoverUserPrompt: template override fills all placeholders", () => {
	const prompt = buildHandoverUserPrompt({
		conversation: "C",
		previousSummary: "P",
		fileInventory: "F",
		extraInstructions: "I",
		maxWords: 123,
		template: "W={maxWords}|C={conversation}|P={previousHandover}|F={fileInventory}|I={extraInstructions}",
	});
	assert.equal(prompt, "W=123|C=C|P=P|F=F|I=I");
});

test("formatFileInventory splits read-only from modified files", () => {
	const inventory = formatFileInventory({
		read: new Set(["a.ts", "b.ts"]),
		written: new Set(["b.ts"]),
		edited: new Set(["c.ts"]),
	});
	assert.ok(inventory.includes("<read-files>\na.ts\n</read-files>"), "read-only files, sorted");
	assert.ok(inventory.includes("<modified-files>\nb.ts\nc.ts\n</modified-files>"), "written + edited, sorted");
});
