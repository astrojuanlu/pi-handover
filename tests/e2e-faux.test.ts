/**
 * End-to-end tests for the session_before_compact hook using the pi SDK
 * and pi-ai's faux provider — fully offline and deterministic.
 *
 * Drives a real AgentSession (in-memory session + in-memory compaction
 * settings) with our extension loaded from extensions/, a scripted faux
 * session model, and a separate faux "handover" model, then asserts the
 * compaction entry, disk persistence, previousSummary threading, and
 * post-compaction continuation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { REQUIRED_SECTIONS, sectionIndices } from "./helpers.ts";

const EXTENSIONS_DIR = join(import.meta.dirname, "..", "extensions");

const HANDOVER_DOC = [
	"# Handover — Faux Mission (2026-01-01)",
	"",
	"## Mission",
	"Secret project word: banana.",
	"",
	"## What has been done",
	"- Verified: received both operation logs.",
	"",
	"## What we have learned",
	"- The user expects exact acknowledgement strings.",
	"",
	"## What is next",
	"1. Acknowledge further logs.",
].join("\n");

interface E2EOptions {
	piHandover?: Record<string, unknown>;
}

interface E2E {
	cwd: string;
	session: import("@earendil-works/pi-coding-agent").AgentSession;
	sessionManager: SessionManager;
	/** User-prompt text of every call made to the handover writer model. */
	handoverPrompts: string[];
}

/** Fixture: temp project + agent dir, isolated ModelRuntime, in-memory session. */
async function setupE2E(options: E2EOptions = {}): Promise<E2E> {
	const cwd = join(tmpdir(), `pihandover-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			piHandover: { handoverModel: "handover", ...(options.piHandover ?? {}) },
		}),
	);

	// Isolated runtime: no real ~/.pi files, no network, no credentials.
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		authPath: join(agentDir, "auth.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});

	const faux = fauxProvider({
		models: [
			{ id: "session-model", name: "Session Model", contextWindow: 200_000, maxTokens: 4096 },
			{ id: "handover", name: "Handover Model", contextWindow: 200_000, maxTokens: 8192 },
		],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });

	const sessionReplies = ["ACK", "ACK2", "DONE", "OK", "OK2", "OK3", "OK4", "OK5"];
	const handoverPrompts: string[] = [];
	const responseFactory: FauxResponseFactory = (context, _options, _state, model) => {
		if (model.id === "handover") {
			// The transcript includes the system message first; capture the user prompt.
			const userMessage = [...context.messages].reverse().find((m) => m.role === "user");
			const blocks = userMessage && Array.isArray(userMessage.content) ? userMessage.content : [];
			handoverPrompts.push(blocks.map((block) => (block.type === "text" ? block.text : "")).join(""));
			return fauxAssistantMessage(HANDOVER_DOC);
		}
		return fauxAssistantMessage(sessionReplies.shift() ?? "OK");
	};
	faux.setResponses(Array.from({ length: 16 }, () => responseFactory));

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, keepRecentTokens: 1 },
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [EXTENSIONS_DIR],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const sessionModel = runtime.getModel("faux", "session-model");
	assert.ok(sessionModel, "faux session model must be registered");

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model: sessionModel,
		settingsManager,
		sessionManager,
		resourceLoader,
	});

	return { cwd, session, sessionManager, handoverPrompts };
}

async function runWorkturns(e2e: E2E): Promise<void> {
	const filler = "payload ".repeat(600); // ~900 tokens per turn
	await e2e.session.prompt("First log. Secret project word: banana. " + filler + " Reply ACK.");
	await e2e.session.prompt("Second log. Secret backup word: mango. " + filler + " Reply ACK2.");
	await e2e.session.prompt("Reply with exactly: DONE");
}

function lastCompaction(e2e: E2E) {
	const entries = e2e.sessionManager.getEntries();
	const compaction = [...entries].reverse().find((e) => e.type === "compaction");
	assert.ok(compaction, "compaction entry must exist");
	if (compaction.type !== "compaction") throw new Error("unreachable");
	return compaction;
}

test("compaction produces a persisted handover document and continues the session", async () => {
	const e2e = await setupE2E();
	try {
		await runWorkturns(e2e);
		await e2e.session.compact();

		const compaction = lastCompaction(e2e);

		// SPEC §2.1: fixed 4-section structure, in order
		assert.ok(compaction.summary.startsWith("# Handover — "), "title heading");
		assert.equal(sectionIndices(compaction.summary).length, REQUIRED_SECTIONS.length, "all four sections in order");
		assert.ok(compaction.summary.includes("banana"), "document carries mission facts");

		// SPEC §2.3: extension-provided, tokens/details stamped
		assert.equal(compaction.fromHook, true);
		assert.ok(compaction.tokensBefore > 0);
		const details = compaction.details as { handoverFile?: string; promptVersion?: number };
		assert.ok(details.handoverFile, "details.handoverFile stamped");
		assert.equal(details.promptVersion, 1);

		// SPEC §2.2: disk persistence
		assert.ok(existsSync(details.handoverFile!), "timestamped file on disk");
		assert.equal(readFileSync(details.handoverFile, "utf8"), compaction.summary, "file content matches summary");
		assert.ok(existsSync(join(e2e.cwd, ".pi", "handover.md")), "fixed-path latest copy exists");

		// Writer was called once for the first compaction, with the conversation
		assert.equal(e2e.handoverPrompts.length, 1);
		assert.ok(e2e.handoverPrompts[0]?.includes("<conversation>"), "conversation serialized");
		assert.ok(!e2e.handoverPrompts[0]?.includes("<base-handover>"), "no base for the first compaction");

		// Session continues with the document as context
		await e2e.session.prompt("Continue: what was the secret project word?");
		assert.ok((e2e.session.getLastAssistantText() ?? "").length > 0, "session still responds after compaction");

		// Iterative compaction: previousSummary is threaded in as the base handover
		await e2e.session.compact();
		assert.equal(e2e.handoverPrompts.length, 2, "second handover call");
		const second = e2e.handoverPrompts[1] ?? "";
		assert.ok(second.includes("<base-handover>"), "base handover threaded");
		assert.ok(second.includes("banana"), "base handover content carried forward");
		assert.ok(second.includes("<conversation-since>"), "conversation-since section");

		const compactions = e2e.sessionManager.getEntries().filter((e) => e.type === "compaction");
		assert.equal(compactions.length, 2, "two compaction entries");
	} finally {
		e2e.session.dispose();
	}
});

test("keepRecent: none clears kept messages — only the document remains", async () => {
	const e2e = await setupE2E({ piHandover: { keepRecent: "none" } });
	try {
		await runWorkturns(e2e);
		await e2e.session.compact();

		const compaction = lastCompaction(e2e);
		assert.equal(compaction.firstKeptEntryId, "none", "sentinel firstKeptEntryId stored");

		// The visible context is exactly the compaction summary — nothing kept.
		// (The compaction entry also re-projects the session system message; that
		// is pi's mechanism, not a kept conversation message.)
		const messages = e2e.sessionManager
			.buildContextEntries()
			.flatMap((entry) => sessionEntryToContextMessages(entry));
		assert.equal(
			messages.filter((m) => m.role !== "compactionSummary" && m.role !== "system").length,
			0,
			"no kept messages survive",
		);
		assert.equal(
			messages.filter((m) => m.role === "compactionSummary").length,
			1,
			"document is the whole context",
		);
	} finally {
		e2e.session.dispose();
	}
});

test("generation failure falls back to pi's default compaction", async () => {
	// handoverModel pointing at a model that does not exist
	const e2e = await setupE2E({ piHandover: { handoverModel: "bogus/no-such-model" } });
	try {
		const filler = "payload ".repeat(600);
		await e2e.session.prompt("First log. Secret project word: banana. " + filler + " Reply ACK.");
		await e2e.session.prompt("Reply with exactly: DONE");

		await e2e.session.compact();

		const compaction = lastCompaction(e2e);
		assert.equal(compaction.fromHook, false, "default compaction, not the hook");
		assert.ok(compaction.summary.length > 0, "a summary was still generated");
		assert.equal(e2e.handoverPrompts.length, 0, "writer model never called");
		assert.ok(!existsSync(join(e2e.cwd, ".pi", "handover.md")), "no handover files written");
	} finally {
		e2e.session.dispose();
	}
});
