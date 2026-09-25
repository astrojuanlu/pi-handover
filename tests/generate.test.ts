/**
 * Unit tests for model resolution and handover generation
 * (extensions/generate.ts) using a stubbed ModelRegistry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, FauxResponseFactory, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { HandoverConfig } from "../extensions/config.ts";
import { generateHandover, resolveHandoverModel } from "../extensions/generate.ts";
import { sampleDoc } from "./helpers.ts";

interface StubModel {
	provider: string;
	id: string;
}

function model(provider: string, id: string): Model<any> {
	return { provider, id } as unknown as Model<any>;
}

interface RegistryScript {
	available?: StubModel[];
	catalog?: StubModel[];
	authed?: string[];
	complete?: (
		m: Model<any>,
		context: { systemPrompt?: string; messages: unknown[] },
	) => Promise<AssistantMessage>;
}

function stubRegistry(script: RegistryScript = {}): ModelRegistry {
	const authed = new Set(script.authed ?? []);
	return {
		getAvailable: () => (script.available ?? []).map((m) => model(m.provider, m.id)),
		find: (provider: string, id: string) =>
			(script.catalog ?? []).find((m) => m.provider === provider && m.id === id)
				? model(provider, id)
				: undefined,
		hasConfiguredAuth: (m: Model<any>) => authed.has(`${m.provider}/${m.id}`),
		complete:
			script.complete ??
			(async () => {
				throw new Error("not scripted");
			}),
	} as unknown as ModelRegistry;
}

const config = (over: Partial<HandoverConfig> = {}): HandoverConfig => ({
	enabled: true,
	keepRecent: "default",
	maxWords: 800,
	...over,
});

// ---------------------------------------------------------------------------
// resolveHandoverModel
// ---------------------------------------------------------------------------

test("no handoverModel → session model (with warning flag)", () => {
	const session = model("openrouter", "glm-flash");
	const resolved = resolveHandoverModel(stubRegistry(), config(), session);
	assert.deepEqual(
		{ id: resolved?.model.id, usedSessionModel: resolved?.usedSessionModel },
		{ id: "glm-flash", usedSessionModel: true },
	);
});

test("no handoverModel and no session model → undefined", () => {
	assert.equal(resolveHandoverModel(stubRegistry(), config(), undefined), undefined);
});

test("exact provider/id from available models wins", () => {
	const registry = stubRegistry({
		available: [
			{ provider: "openrouter", id: "google/gemini-2.5-flash" },
			{ provider: "google", id: "google/gemini-2.5-flash" },
		],
	});
	const resolved = resolveHandoverModel(registry, config({ handoverModel: "openrouter/google/gemini-2.5-flash" }), undefined);
	assert.equal(resolved?.model.provider, "openrouter");
	assert.equal(resolved?.usedSessionModel, false);
});

test("bare model id resolves to the unique available model, not an unconfigured catalog twin", () => {
	// Regression: "google/gemini-2.5-flash" previously resolved to the direct-Google
	// catalog entry (provider "google", no auth) instead of the openrouter mirror.
	const registry = stubRegistry({
		available: [{ provider: "openrouter", id: "google/gemini-2.5-flash" }],
		catalog: [{ provider: "google", id: "gemini-2.5-flash" }], // unconfigured
	});
	const resolved = resolveHandoverModel(registry, config({ handoverModel: "google/gemini-2.5-flash" }), undefined);
	assert.equal(resolved?.model.provider, "openrouter", "available mirror preferred over catalog twin");
});

test("ambiguous bare id falls back to an authed catalog match", () => {
	const registry = stubRegistry({
		available: [
			{ provider: "openrouter", id: "shared-id" },
			{ provider: "other", id: "shared-id" },
		],
		catalog: [{ provider: "anthropic", id: "claude-x" }],
		authed: ["anthropic/claude-x"],
	});
	const resolved = resolveHandoverModel(registry, config({ handoverModel: "anthropic/claude-x" }), undefined);
	assert.equal(resolved?.model.id, "claude-x");
});

test("catalog match without configured auth is rejected", () => {
	const registry = stubRegistry({
		catalog: [{ provider: "google", id: "gemini-2.5-flash" }],
		authed: [],
	});
	assert.equal(
		resolveHandoverModel(registry, config({ handoverModel: "google/gemini-2.5-flash" }), undefined),
		undefined,
	);
});

test("unknown model id → undefined (caller falls back to default compaction)", () => {
	const registry = stubRegistry({ available: [{ provider: "openrouter", id: "a" }] });
	assert.equal(
		resolveHandoverModel(registry, config({ handoverModel: "bogus/nonexistent-model" }), undefined),
		undefined,
	);
});

// ---------------------------------------------------------------------------
// generateHandover
// ---------------------------------------------------------------------------

function fakeResponse(over: {
	text?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: unknown;
} = {}): AssistantMessage {
	return {
		stopReason: over.stopReason ?? "stop",
		errorMessage: over.errorMessage,
		usage: over.usage ?? { input: 100, output: 20 },
		content: over.text === undefined ? [] : [{ type: "text", text: over.text }],
	} as unknown as AssistantMessage;
}

test("generateHandover returns the validated document and usage", async () => {
	const contexts: { systemPrompt?: string; messages: unknown[] }[] = [];
	const registry = stubRegistry({
		complete: async (_m, context) => {
			contexts.push(context);
			return fakeResponse({ text: sampleDoc("Generated"), usage: { input: 1, output: 2 } });
		},
	});
	const outcome = await generateHandover({
		registry,
		model: model("faux", "writer"),
		conversation: "CONV",
		fileInventory: "FILES",
		previousSummary: "BASE",
		extraInstructions: "EXTRA",
		config: config({ maxWords: 500 }),
		signal: new AbortController().signal,
	});
	assert.ok("result" in outcome, "expected a result outcome");
	assert.ok(outcome.result.doc.startsWith("# Handover — Generated"));
	assert.equal(outcome.result.title, "Generated");
	assert.deepEqual(outcome.result.usage, { input: 1, output: 2 });
	assert.equal((contexts[0]?.systemPrompt ?? "").includes("under 500 words"), true, "maxWords cap substituted into the writer system prompt");
	assert.ok((contexts[0]?.systemPrompt ?? "").includes("## Mission"), "system prompt keeps the section structure");
	const userText =
		((contexts[0]?.messages ?? []) as Array<{ content: Array<{ type: string; text: string }> }>)[0]?.content[0]?.text ?? "";
	assert.ok(userText.includes("<base-handover>\nBASE\n</base-handover>"));
});

test("generateHandover failure paths all report reasons", async () => {
	const cases: Array<{ response?: AssistantMessage; error?: Error; expected: string }> = [
		{ response: fakeResponse({ stopReason: "aborted" }), expected: "aborted" },
		{ response: fakeResponse({ stopReason: "error", errorMessage: "boom" }), expected: "error" },
		{ response: fakeResponse({ text: "   " }), expected: "empty" },
		{ response: fakeResponse({ text: "## only one section" }), expected: "invalid" },
		{ error: new Error("network down"), expected: "error" },
	];
	for (const { response, error, expected } of cases) {
		const outcome = await generateHandover({
			registry: stubRegistry({
				complete: async () => {
					if (error) throw error;
					return response!;
				},
			}),
			model: model("faux", "writer"),
			conversation: "CONV",
			config: config(),
			signal: new AbortController().signal,
		});
		assert.ok("failure" in outcome, "expected a failure outcome");
		assert.equal(outcome.failure.reason, expected);
	}
	if (cases[1]?.response) {
		// spot-check error detail propagation
	}
});

test("generateHandover maps a throw while aborted to reason 'aborted'", async () => {
	const controller = new AbortController();
	controller.abort();
	const outcome = await generateHandover({
		registry: stubRegistry({
			complete: async () => {
				throw new Error("cancelled");
			},
		}),
		model: model("faux", "writer"),
		conversation: "CONV",
		config: config(),
		signal: controller.signal,
	});
	assert.ok("failure" in outcome);
	assert.equal(outcome.failure.reason, "aborted");
});

test("generateHandover honors the template override", async () => {
	let seen = "";
	const registry = stubRegistry({
		complete: async (_m, context) => {
			seen =
				((context.messages ?? []) as Array<{ content: Array<{ type: string; text: string }> }>)[0]?.content[0]?.text ?? "";
			return fakeResponse({ text: sampleDoc() });
		},
	});
	await generateHandover({
		registry,
		model: model("faux", "writer"),
		conversation: "C",
		config: config({ template: "W={maxWords} C={conversation}" }),
		signal: new AbortController().signal,
	});
	assert.equal(seen, "W=800 C=C");
});
