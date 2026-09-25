/**
 * pi-handover configuration.
 *
 * Reads the `piHandover` object from pi settings files:
 *   - global:  `<agentDir>/settings.json`
 *   - project: `<cwd>/.pi/settings.json` (honored only when the project is trusted)
 *
 * Project settings override global settings. Unknown/invalid values fall back
 * to the defaults from SPEC.md §2.6.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface HandoverConfig {
	/** Hook active at all (default: true). */
	enabled: boolean;
	/** Model id used for handover generation (default: current session model). */
	handoverModel?: string | undefined;
	/** "none" clears kept messages after compaction (default: "default"). */
	keepRecent: "default" | "none";
	/** Where handover documents are written, relative to cwd (default: ".pi/handovers"). */
	outputDir?: string | undefined;
	/** Length cap for the document in words (default: 800). */
	maxWords: number;
	/** Optional full prompt-template override (placeholder-based). */
	template?: string | undefined;
}

export const DEFAULT_OUTPUT_DIR = ".pi/handovers";
export const DEFAULT_MAX_WORDS = 800;
export const LATEST_HANDOVER_FILENAME = ".pi/handover.md";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettingsObject(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function readHandoverSection(path: string): Record<string, unknown> {
	const raw = readSettingsObject(path)?.["piHandover"];
	return isPlainObject(raw) ? raw : {};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Load and sanitize the piHandover configuration. */
export function loadHandoverConfig(cwd: string, projectTrusted: boolean): HandoverConfig {
	const globalSection = readHandoverSection(join(getAgentDir(), "settings.json"));
	const projectSection = projectTrusted ? readHandoverSection(join(cwd, CONFIG_DIR_NAME, "settings.json")) : {};
	const merged = { ...globalSection, ...projectSection };

	const maxWordsRaw = merged["maxWords"];
	return {
		enabled: merged["enabled"] === undefined ? true : Boolean(merged["enabled"]),
		handoverModel: optionalString(merged["handoverModel"]),
		keepRecent: merged["keepRecent"] === "none" ? "none" : "default",
		outputDir: optionalString(merged["outputDir"]),
		maxWords:
			typeof maxWordsRaw === "number" && Number.isFinite(maxWordsRaw) && maxWordsRaw > 0
				? Math.floor(maxWordsRaw)
				: DEFAULT_MAX_WORDS,
		template: optionalString(merged["template"]),
	};
}
