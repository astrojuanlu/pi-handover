/**
 * Unit tests for piHandover settings loading (extensions/config.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHandoverConfig } from "../extensions/config.ts";
import { makeTempDir } from "./helpers.ts";

interface Fixture {
	cwd: string;
	agentDir: string;
}

/** Create a temp cwd + agent dir; the loader reads the agent dir via PI_CODING_AGENT_DIR. */
function fixture(globalSettings: unknown, projectSettings?: unknown): Fixture {
	const cwd = makeTempDir("pihandover-cfg-");
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
	if (projectSettings !== undefined) {
		const projectPi = join(cwd, ".pi");
		mkdirSync(projectPi, { recursive: true });
		writeFileSync(join(projectPi, "settings.json"), JSON.stringify(projectSettings));
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return { cwd, agentDir };
}

test("defaults when nothing is configured", () => {
	const { cwd } = fixture({ someOtherSetting: true });
	const cfg = loadHandoverConfig(cwd, false);
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.keepRecent, "default");
	assert.equal(cfg.handoverModel, undefined);
	assert.equal(cfg.outputDir, undefined);
	assert.equal(cfg.maxWords, 800);
	assert.equal(cfg.template, undefined);
});

test("reads piHandover from the global agent dir", () => {
	const { cwd } = fixture({
		piHandover: {
			enabled: false,
			handoverModel: "openrouter/google/gemini-2.5-flash",
			keepRecent: "none",
			outputDir: "docs/handovers",
			maxWords: 500,
			template: "T {conversation}",
		},
	});
	const cfg = loadHandoverConfig(cwd, false);
	assert.equal(cfg.enabled, false);
	assert.equal(cfg.handoverModel, "openrouter/google/gemini-2.5-flash");
	assert.equal(cfg.keepRecent, "none");
	assert.equal(cfg.outputDir, "docs/handovers");
	assert.equal(cfg.maxWords, 500);
	assert.equal(cfg.template, "T {conversation}");
});

test("legacy piHandoff key is not read", () => {
	const { cwd } = fixture({ piHandoff: { handoverModel: "legacy-key-model" } });
	const cfg = loadHandoverConfig(cwd, false);
	assert.equal(cfg.handoverModel, undefined, "piHandoff must be ignored");
});

test("project settings are ignored for untrusted projects", () => {
	const { cwd } = fixture(
		{ piHandover: { maxWords: 500 } },
		{ piHandover: { maxWords: 333 } },
	);
	const cfg = loadHandoverConfig(cwd, false);
	assert.equal(cfg.maxWords, 500);
});

test("trusted project settings override global settings", () => {
	const { cwd } = fixture(
		{ piHandover: { maxWords: 500, handoverModel: "global-model" } },
		{ piHandover: { maxWords: 333 } },
	);
	const cfg = loadHandoverConfig(cwd, true);
	assert.equal(cfg.maxWords, 333);
	assert.equal(cfg.handoverModel, "global-model", "unset project keys keep the global value");
});

test("invalid values fall back to defaults", () => {
	const { cwd } = fixture({
		piHandover: {
			enabled: 0,
			keepRecent: "bogus",
			maxWords: "not-a-number",
			handoverModel: "   ",
			outputDir: "",
		},
	});
	const cfg = loadHandoverConfig(cwd, false);
	assert.equal(cfg.enabled, false, "0 is a valid falsy boolean");
	assert.equal(cfg.keepRecent, "default");
	assert.equal(cfg.maxWords, 800);
	assert.equal(cfg.handoverModel, undefined);
	assert.equal(cfg.outputDir, undefined);
});

test("maxWords accepts numbers, floors non-integers, rejects non-positive", () => {
	const { cwd: cwdA } = fixture({ piHandover: { maxWords: 421.9 } });
	assert.equal(loadHandoverConfig(cwdA, false).maxWords, 421);
	const { cwd: cwdB } = fixture({ piHandover: { maxWords: 0 } });
	assert.equal(loadHandoverConfig(cwdB, false).maxWords, 800);
	const { cwd: cwdC } = fixture({ piHandover: { maxWords: Number.POSITIVE_INFINITY } });
	assert.equal(loadHandoverConfig(cwdC, false).maxWords, 800);
});

test("non-object piHandover sections are ignored", () => {
	const { cwd } = fixture({ piHandover: "garbage" });
	const cfg = loadHandoverConfig(cwd, false);
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.handoverModel, undefined);
});
