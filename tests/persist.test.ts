/**
 * Unit tests for handover document persistence (extensions/persist.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { persistHandover, slugify, timestampSlug } from "../extensions/persist.ts";
import { makeTempDir, sampleDoc } from "./helpers.ts";

test("slugify sanitizes titles into filename slugs", () => {
	assert.equal(slugify("Fix the flaky test — run #3!"), "fix-the-flaky-test-run-3");
	assert.equal(slugify("!!!"), "handover", "fallback when nothing remains");
	assert.equal(slugify("x".repeat(60)).length, 40, "max 40 chars");
	assert.equal(slugify("trailing dashes---"), "trailing-dashes");
});

test("timestampSlug produces a UTC filename-safe timestamp", () => {
	const ts = timestampSlug();
	assert.match(ts, /^\d{8}T\d{6}Z$/, "shape YYYYMMDDTHHMMSSZ");
	const fixed = timestampSlug(new Date("2026-09-25T17:19:30.123Z"));
	assert.equal(fixed, "20260925T171930Z");
});

test("persistHandover writes the timestamped file and the latest copy", () => {
	const cwd = makeTempDir("pihandover-persist-");
	const doc = sampleDoc("Persisted Title");
	const out = persistHandover(doc, cwd, undefined, "Persisted Title");
	assert.ok(out, "returns paths");
	assert.ok(existsSync(out.handoverFile), "timestamped file exists");
	assert.ok(existsSync(out.latestFile), "latest copy exists");
	const [name] = readdirSync(join(cwd, ".pi", "handovers"));
	assert.match(name ?? "", /^\d{8}T\d{6}Z-persisted-title\.md$/);
	assert.equal(readFileSync(out.latestFile, "utf8"), doc, "latest copy contains the document");
});

test("persistHandover writes into a configured outputDir", () => {
	const cwd = makeTempDir("pihandover-persist-");
	const out = persistHandover(sampleDoc(), cwd, "docs/handovers", "Title");
	assert.ok(out?.handoverFile.includes(join("docs", "handovers")));
	assert.ok(!out || existsSync(out.handoverFile));
	assert.ok(existsSync(join(cwd, ".pi", "handover.md")), "fixed-path latest copy always in .pi");
});

test("persistHandover is best-effort: write failures never throw", () => {
	const cwd = makeTempDir("pihandover-persist-");
	const blocker = join(cwd, "blocker");
	writeFileSync(blocker, "not a directory");
	// outputDir resolves to a path under a regular file → mkdir fails
	const out = persistHandover(sampleDoc(), cwd, "blocker/handovers", "Title");
	assert.equal(out, undefined, "returns undefined instead of throwing");
});
