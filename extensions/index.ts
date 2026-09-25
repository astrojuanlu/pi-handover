/**
 * pi-handover — handover-document compaction for the pi coding agent.
 *
 * Replaces pi's default compaction with a structured, persisted handover
 * document (Mission / What has been done / What we have learned /
 * What is next) so that a model whose context was cleared can continue the
 * work as if a competent colleague had briefed it. See SPEC.md.
 *
 * - `session_before_compact` hook: generates the doc for threshold, manual,
 *   and overflow compactions; falls back to default compaction on any failure.
 * - `/handover [instructions]`: triggers in-place compaction with extra
 *   instructions threaded into the handover prompt.
 * - `/handover-dry`: generates + shows the document without compacting.
 */

import { BorderedLoader, convertToLlm, getLatestCompactionEntry, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadHandoverConfig, type HandoverConfig } from "./config.ts";
import { formatFileInventory, type FileOperations } from "./handover.ts";
import { generateHandover, resolveHandoverModel, type AgentMessages, type GenerateHandoverOutcome } from "./generate.ts";
import { persistHandover } from "./persist.ts";
import { HANDOVER_PROMPT_VERSION } from "./handover.ts";
/** Sentinel firstKeptEntryId that matches no entry: keeps nothing (keepRecent: "none"). */
const KEEP_NONE = "none";

interface HandoverContext {
	conversation: string;
	fileInventory?: string | undefined;
}

/** Serialize doomed messages + extract the cumulative file inventory. */
function buildHandoverContext(messages: AgentMessages, fileOps: FileOperations): HandoverContext {
	const conversation = serializeConversation(convertToLlm(messages));
	return { conversation, fileInventory: formatFileInventory(fileOps) };
}

/** Flatten the current branch into messages, folding the latest compaction into previousSummary. */
function collectDryRunContext(entries: SessionEntry[]): { messages: AgentMessages; previousSummary?: string | undefined } {
	const latest = getLatestCompactionEntry(entries);
	const messages: AgentMessages = entries
		.filter((entry) => entry.type === "message" && entry.message.role !== "system")
		.map((entry) => (entry.type === "message" ? entry.message : undefined))
		.filter((message) => message !== undefined);
	return latest?.summary ? { messages, previousSummary: latest.summary } : { messages };
}

export default function (pi: ExtensionAPI) {
	// Warn once per session when the handover falls back to the (possibly weak)
	// session model because no handoverModel is configured.
	let warnedSessionModel = false;

	// SPEC §2.3: hook integration for all trigger reasons.
	pi.on("session_before_compact", async (event, ctx) => {
		const config = loadHandoverConfig(ctx.cwd, ctx.isProjectTrusted());
		if (!config.enabled) return;

		const { preparation, customInstructions, signal } = event;
		const doomedMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		if (doomedMessages.length === 0) return; // nothing to summarize; let pi decide

		const resolved = resolveHandoverModel(ctx.modelRegistry, config, ctx.model);
		if (!resolved) {
			ctx.ui.notify(
				`pi-handover: handoverModel "${config.handoverModel}" not found; using default compaction`,
				"warning",
			);
			return;
		}
		if (resolved.usedSessionModel && !warnedSessionModel) {
			warnedSessionModel = true;
			ctx.ui.notify(
				`pi-handover: no handoverModel configured; writing the handover with the session model (${resolved.model.id})`,
				"warning",
			);
		}

		try {
			const context = buildHandoverContext(doomedMessages, preparation.fileOps);

			const outcome = await generateHandover({
				registry: ctx.modelRegistry,
				model: resolved.model,
				conversation: context.conversation,
				fileInventory: context.fileInventory,
				previousSummary: preparation.previousSummary,
				extraInstructions: customInstructions,
				config,
				signal,
			});

			// Fallback is mandatory: empty/failed/aborted → default compaction.
			if ("failure" in outcome) {
				if (!signal.aborted) {
					const detail = outcome.failure.detail ? `: ${outcome.failure.detail}` : "";
					ctx.ui.notify(
						`pi-handover: handover generation failed (${outcome.failure.reason}${detail}); using default compaction`,
						"warning",
					);
				}
				return;
			}
			const generated = outcome.result;

			const persisted = persistHandover(generated.doc, ctx.cwd, config.outputDir, generated.title);
			if (!persisted) {
				ctx.ui.notify("pi-handover: could not write handover files (continuing without persistence)", "warning");
			}

			const firstKeptEntryId = config.keepRecent === "none" ? KEEP_NONE : preparation.firstKeptEntryId;
			return {
				compaction: {
					summary: generated.doc,
					firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					...(generated.usage ? { usage: generated.usage } : {}),
					...(persisted
						? { details: { handoverFile: persisted.handoverFile, promptVersion: HANDOVER_PROMPT_VERSION } }
						: {}),
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!signal.aborted) ctx.ui.notify(`pi-handover: ${message}; using default compaction`, "warning");
			return;
		}
	});

	// Announce where the handover was written (covers /handover, /compact and auto triggers).
	pi.on("session_compact", async (event, ctx) => {
		const details = event.compactionEntry.details as { handoverFile?: string } | undefined;
		if (event.fromExtension && details?.handoverFile) {
			ctx.ui.notify(`Handover written: ${details.handoverFile}`, "info");
		}
	});

	// SPEC §2.5: /handover [extra instructions] → in-place compaction.
	pi.registerCommand("handover", {
		description: "Write a handover document and compact in place (extra instructions optional)",
		handler: async (args, ctx) => {
			const config = loadHandoverConfig(ctx.cwd, ctx.isProjectTrusted());
			if (!config.enabled) {
				ctx.ui.notify("pi-handover is disabled (piHandover.enabled = false)", "warning");
				return;
			}
			const instructions = args.trim();
			ctx.compact({
				...(instructions ? { customInstructions: instructions } : {}),
				onError: (error) => ctx.ui.notify(`Handover failed: ${error.message}`, "error"),
			});
		},
	});

	// SPEC §2.5: /handover-dry → generate + show, do not compact.
	pi.registerCommand("handover-dry", {
		description: "Generate the handover document for review without compacting",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handover-dry requires interactive mode", "warning");
				return;
			}
			const config = loadHandoverConfig(ctx.cwd, ctx.isProjectTrusted());
			if (!config.enabled) {
				ctx.ui.notify("pi-handover is disabled (piHandover.enabled = false)", "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			const resolved = resolveHandoverModel(ctx.modelRegistry, config, ctx.model);
			if (!resolved) {
				ctx.ui.notify(`pi-handover: handoverModel "${config.handoverModel}" not found`, "error");
				return;
			}

			const { messages, previousSummary } = collectDryRunContext(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}
			const context = buildHandoverContext(messages, { read: new Set(), written: new Set(), edited: new Set() });

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating handover document (dry run)...");
				loader.onAbort = () => done(null);

				const controller = new AbortController();
				loader.signal.addEventListener("abort", () => controller.abort());

				generateHandover({
					registry: ctx.modelRegistry,
					model: resolved.model,
					conversation: context.conversation,
					fileInventory: context.fileInventory,
					previousSummary,
					extraInstructions: args.trim() || undefined,
					config,
					signal: controller.signal,
				})
					.then((outcome: GenerateHandoverOutcome) => done("result" in outcome ? outcome.result.doc : null))
					.catch(() => done(null));

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Handover generation failed or was cancelled; nothing was compacted", "warning");
				return;
			}

			await ctx.ui.editor("Handover preview (dry run — nothing was compacted)", result);
		},
	});
}

export type { HandoverConfig };
