/**
 * Handover generation: model resolution (SPEC.md §2.4) and the one-off
 * LLM call that writes the document (SPEC.md §2.3).
 */

import { type Message, type Model, type Usage, uuidv7 } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildHandoverUserPrompt, extractTitle, HANDOVER_PROMPT, validateHandoverDoc, withReconciliationNote } from "./handover.ts";
import type { HandoverConfig } from "./config.ts";

/** Agent message array type accepted by pi's convertToLlm. */
export type AgentMessages = Parameters<typeof import("@earendil-works/pi-coding-agent").convertToLlm>[0];

export interface ResolvedHandoverModel {
	model: Model<any>;
	/** True when no handoverModel is configured and the session model is used. */
	usedSessionModel: boolean;
}

/**
 * Resolve the handover model: config override → current session model.
 * Returns undefined when the configured model cannot be found (→ caller
 * falls back to pi's default compaction).
 */
export function resolveHandoverModel(
	registry: ModelRegistry,
	config: HandoverConfig,
	sessionModel: Model<any> | undefined,
): ResolvedHandoverModel | undefined {
	const wanted = config.handoverModel;
	if (!wanted) {
		return sessionModel ? { model: sessionModel, usedSessionModel: true } : undefined;
	}

	// Prefer models that are actually usable (available + configured auth), so a
	// bare model id like "google/gemini-2.5-flash" resolves to the openrouter
	// mirror rather than an unconfigured direct-Google catalog entry.
	const available = registry.getAvailable();
	const byExact = available.find((m) => `${m.provider}/${m.id}` === wanted);
	if (byExact) return { model: byExact, usedSessionModel: false };
	const idMatches = available.filter((m) => m.id === wanted);
	if (idMatches.length === 1) return { model: idMatches[0]!, usedSessionModel: false };

	// Fall back to the full catalogue, but only if the provider is configured.
	const slash = wanted.indexOf("/");
	if (slash > 0) {
		const byProviderId = registry.find(wanted.slice(0, slash), wanted.slice(slash + 1));
		if (byProviderId && registry.hasConfiguredAuth(byProviderId)) {
			return { model: byProviderId, usedSessionModel: false };
		}
	}
	return undefined;
}

export interface GenerateHandoverArgs {
	registry: ModelRegistry;
	model: Model<any>;
	conversation: string;
	fileInventory?: string | undefined;
	previousSummary?: string | undefined;
	extraInstructions?: string | undefined;
	config: HandoverConfig;
	signal: AbortSignal;
}

export interface GeneratedHandover {
	doc: string;
	title: string;
	usage: Usage | undefined;
}

export interface GenerateHandoverFailure {
	reason: "aborted" | "error" | "empty" | "invalid";
	detail?: string | undefined;
}

/**
 * Call the handover model and validate the resulting document.
 * Every failure mode (abort, provider error, empty output, missing sections)
 * is reported as a {@link GenerateHandoverFailure} — the caller must then
 * fall back to pi's default compaction (SPEC.md §2.3).
 */
export type GenerateHandoverOutcome = { result: GeneratedHandover } | { failure: GenerateHandoverFailure };

export async function generateHandover(args: GenerateHandoverArgs): Promise<GenerateHandoverOutcome> {
	const userPrompt = buildHandoverUserPrompt({
		conversation: args.conversation,
		fileInventory: args.fileInventory,
		previousSummary: args.previousSummary,
		extraInstructions: args.extraInstructions,
		maxWords: args.config.maxWords,
		template: args.config.template,
	});

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: userPrompt }],
		timestamp: Date.now(),
	};

	const systemPrompt = HANDOVER_PROMPT.replaceAll("{maxWords}", String(args.config.maxWords));

	try {
		const response = await args.registry.complete(
			args.model,
			{ systemPrompt, messages: [userMessage] },
			{
				maxTokens: 8192,
				signal: args.signal,
				cacheRetention: "none",
				sessionId: uuidv7(),
			},
		);

		if (response.stopReason === "aborted") {
			return { failure: { reason: "aborted" } };
		}
		if (response.stopReason === "error") {
			return { failure: { reason: "error", detail: response.errorMessage } };
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		if (!text.trim()) {
			return { failure: { reason: "empty" } };
		}

		const validated = validateHandoverDoc(text);
		if (!validated) {
			return { failure: { reason: "invalid", detail: `head: ${text.slice(0, 160)}` } };
		}

		const doc = withReconciliationNote(validated);

		return {
			result: { doc, title: extractTitle(doc), usage: response.usage },
		};
	} catch (error) {
		if (args.signal.aborted) return { failure: { reason: "aborted" } };
		const message = error instanceof Error ? error.message : String(error);
		return { failure: { reason: "error", detail: message } };
	}
}
