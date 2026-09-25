/**
 * Disk persistence of handover documents (SPEC.md §2.2).
 *
 * Best-effort: any write failure is swallowed (returns undefined paths) and
 * must never abort compaction.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_OUTPUT_DIR, LATEST_HANDOVER_FILENAME } from "./config.ts";

/** Sanitize a one-line title into a filename slug (max 40 chars). */
export function slugify(title: string, max = 40): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/, "");
	return slug || "handover";
}

/** UTC timestamp like `20260925T171930Z`. */
export function timestampSlug(date = new Date()): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface PersistedHandover {
	/** Timestamped document inside the output directory. */
	handoverFile: string;
	/** Fixed-path copy of the latest document. */
	latestFile: string;
}

/**
 * Write the document to `<cwd>/.pi/handovers/<UTC-timestamp>-<slug>.md` and
 * copy it to `<cwd>/.pi/handover.md`. Returns undefined on any write failure.
 */
export function persistHandover(doc: string, cwd: string, outputDir: string | undefined, title: string): PersistedHandover | undefined {
	try {
		const dir = join(cwd, outputDir ?? DEFAULT_OUTPUT_DIR);
		mkdirSync(dir, { recursive: true });
		const handoverFile = join(dir, `${timestampSlug()}-${slugify(title)}.md`);
		writeFileSync(handoverFile, doc, "utf8");

		// The latest copy lives in .pi regardless of outputDir; make sure the
		// directory exists when outputDir points elsewhere.
		const latestFile = join(cwd, LATEST_HANDOVER_FILENAME);
		mkdirSync(dirname(latestFile), { recursive: true });
		writeFileSync(latestFile, doc, "utf8");

		return { handoverFile, latestFile };
	} catch {
		return undefined;
	}
}
