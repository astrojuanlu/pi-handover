/**
 * The handover document: versioned writer prompt, user-prompt assembly,
 * and structural validation (SPEC.md §2.1).
 */

export const HANDOVER_PROMPT_VERSION = 1;

/** Shape of pi's cumulative file-operation tracker. */
export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/**
 * Format cumulative file operations as <read-files>/<modified-files> blocks,
 * matching pi's default summary format (files only read vs. files modified).
 */
export function formatFileInventory(fileOps: FileOperations): string {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	const sorted = (paths: Iterable<string>) => [...paths].sort().join("\n");
	const readOnly = sorted([...fileOps.read].filter((path) => !modified.has(path)));
	return `<read-files>\n${readOnly}\n</read-files>\n\n<modified-files>\n${sorted(modified)}\n</modified-files>`;
}

/**
 * System prompt for the handover writer model. Versioned per SPEC.md:
 * instructs fact discipline and the fixed 4-section structure.
 */
export const HANDOVER_PROMPT = `You are a handover writer. You will be given the transcript of an agent session whose context is about to be cleared, plus optional previous handover material. Your job is to write a handover document that lets a competent colleague — or the same agent with an empty context — continue the work exactly where it left off.

Rules:
- Use ONLY facts present in the supplied transcript. Never invent paths, commands, results, or completions.
- Do not mark anything done that is not verifiably done in the transcript.
- Distinguish verified work from unverified attempts and attempted-and-failed work.
- Keep tool-output noise out; keep essential results, paths, and commands in.
- Keep the document under {maxWords} words.
- If a base handover document is supplied, treat it as the starting point: carry every still-relevant item forward, update what changed, drop only what is genuinely superseded. Never silently drop still-relevant content.
- Output the document only. No preamble, no commentary, no code fences around the whole document.

The document MUST use exactly this structure — these four top-level sections, in this order (content may add sub-structure, never remove or reorder):

# Handover — <one-line task title> (<ISO date YYYY-MM-DD>)

## Mission
What the user is trying to accomplish, verbatim constraints and preferences, success criteria. If a previous handover is supplied, merge it in and supersede it — never drop still-relevant content.

## What has been done
Completed and verified work, each item with artifact paths (files written, results, logs). Mark items clearly as verified, unverified, or attempted-and-failed. Include a cumulative inventory of files read and files modified (use the supplied file inventory).

## What we have learned
Decisions with rationale, pitfalls discovered, false leads closed, environment facts (paths, tokens, versions), and things that did NOT work.

## What is next
Numbered, executable next steps with exact commands where applicable. Include resume hints: which files to read first, and what NOT to redo.`;

/** The four required section headings, in required order. */
const REQUIRED_SECTIONS = [
	"mission",
	"what has been done",
	"what we have learned",
	"what is next",
] as const;

export interface HandoverPromptInput {
	conversation: string;
	/** Formatted <read-files>/<modified-files> block from cumulative file ops. */
	fileInventory?: string | undefined;
	/** Summary of the previous compaction, threaded in for iterative compaction. */
	previousSummary?: string | undefined;
	/** Extra instructions from /handover or /compact. */
	extraInstructions?: string | undefined;
	maxWords: number;
	/** Optional full prompt-template override. */
	template?: string | undefined;
}

function fillTemplate(
	template: string,
	values: { conversation: string; fileInventory: string; previousHandover: string; extraInstructions: string; maxWords: number },
): string {
	return template
		.replaceAll("{conversation}", values.conversation)
		.replaceAll("{fileInventory}", values.fileInventory)
		.replaceAll("{previousHandover}", values.previousHandover)
		.replaceAll("{extraInstructions}", values.extraInstructions)
		.replaceAll("{maxWords}", String(values.maxWords));
}

/** Assemble the user prompt for the handover writer model. */
export function buildHandoverUserPrompt(input: HandoverPromptInput): string {
	const values = {
		conversation: input.conversation,
		fileInventory: input.fileInventory ?? "",
		previousHandover: input.previousSummary ?? "",
		extraInstructions: input.extraInstructions ?? "",
		maxWords: input.maxWords,
	};

	if (input.template) {
		return fillTemplate(input.template, values);
	}

	const parts: string[] = [];
	if (input.previousSummary) {
		parts.push(
			`Update the base handover document below with what happened since it was written. ` +
				`The result replaces the base: fold all still-relevant content in, supersede what changed, never drop still-relevant content.\n\n` +
				`<base-handover>\n${input.previousSummary}\n</base-handover>`,
		);
	} else {
		parts.push(
			`Write the handover document for the conversation below. Keep it under ${input.maxWords} words.\n\n` +
				`<conversation>\n${input.conversation}\n</conversation>`,
		);
	}
	if (input.previousSummary) {
		parts.push(`<conversation-since>\n${input.conversation}\n</conversation-since>`);
	}
	if (input.fileInventory) {
		parts.push(`<file-inventory>\n${input.fileInventory}\n</file-inventory>`);
	}
	if (input.extraInstructions) {
		parts.push(`<extra-instructions>\n${input.extraInstructions}\n</extra-instructions>`);
	}
	return parts.join("\n\n");
}

/** Strip a single wrapping markdown code fence, if the model added one. */
function stripCodeFence(text: string): string {
	const fenced = text.match(/^```[^\n]*\n([\s\S]*)\n```\s*$/);
	return fenced?.[1] ?? text;
}

/**
 * Validate the generated document: all four sections present, in order.
 * Returns the normalized document, or null if it must be treated as a
 * generation failure (→ default compaction fallback per SPEC.md §2.3).
 */
export function validateHandoverDoc(raw: string): string | null {
	const text = stripCodeFence(raw).trim();
	if (!text) return null;

	let cursor = -1;
	for (const section of REQUIRED_SECTIONS) {
		const heading = `## ${section}`;
		const index = text.toLowerCase().indexOf(heading, cursor + 1);
		if (index < 0) return null;
		cursor = index;
	}

	// Ensure the required first-level title heading exists, and stamp the real
	// UTC date (the model tends to invent one; the date is session metadata).
	const date = new Date().toISOString().slice(0, 10);
	if (!text.startsWith("# ")) {
		return `# Handover (${date})\n\n${text}`;
	}
	const firstLineEnd = text.indexOf("\n");
	const firstLine = text.slice(0, firstLineEnd < 0 ? text.length : firstLineEnd);
	const normalizedHeading = firstLine.replace(/\(\d{4}-\d{2}-\d{2}\)\s*$/, `(${date})`);
	return `${normalizedHeading}${text.slice(firstLineEnd)}`;
}

/** Extract the one-line task title from the document heading. */
export function extractTitle(doc: string): string {
	const match = doc.match(/^#\s+Handover\s*[—–-]\s*(.+?)\s*\(\d{4}-\d{2}-\d{2}\)\s*$/m);
	const title = match?.[1]?.trim();
	return title && title.length > 0 ? title : "handover";
}
