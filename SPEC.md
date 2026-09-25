# SPEC — pi-handover

**Status:** scaffold · **Target:** pi coding agent (pi.dev) extension/package
**One-liner:** Replace pi's default compaction with a structured, persisted **handover document** so that a model whose context was cleared can continue the work as if a competent colleague had briefed it.

## 1. Problem

pi's built-in compaction generates a lossy rolling summary and keeps the last
`keepRecentTokens` (~20k tokens). Observed failure modes (see "Background" in
§6): flash-tier models degrade badly at long real-world agentic contexts
(>~150k tokens) — they confabulate (claim reads were "truncated/condensed",
deny prior work, re-execute the session's first task) long before any
mechanism intervenes, and the default summary is optimized for continuation
token-efficiency, not for *fidelity of mission state*.

What we want instead: when the context must be cleared, the agent first writes
a **handover document** with a fixed, predictable structure, the context is
then cleared, and the handover doc becomes the model's entire visible history
(also persisted to disk so it survives session loss).

## 2. Behavior

### 2.1 The handover document (fixed 4-section structure)

The generated document MUST contain exactly these top-level sections, in this
order (content may add sub-structure, never remove or reorder):

```markdown
# Handover — <one-line task title> (<ISO date>)

## Mission
What the user is trying to accomplish, verbatim constraints & preferences,
success criteria. If the session inherited a previous handover, merge and
supersede, never drop.

## What has been done
Completed and verified work, with artifact paths (files written, results,
logs). Distinguish verified vs. unverified vs. attempted-and-failed.
Cumulative read/modified file inventory (from `preparation.fileOps`).

## What we have learned
Decisions with rationale, pitfalls discovered, false leads closed,
environment facts (paths, tokens, versions), things that did NOT work.

## What is next
Numbered, executable next steps with exact commands where applicable.
Include "resume hints": which files to read first, what NOT to redo.
```

Rules:
- The prompt to the writer model is versioned and shipped as a constant
  (`HANDOVER_PROMPT`); it instructs: use only facts from the supplied
  transcript; never invent paths, results, or completions; keep tool-output
  noise out; keep under N words (configurable, default ~800).
- The document is (a) returned as the compaction `summary` — i.e. it becomes
  the model's visible context — and (b) written to disk.

### 2.2 Disk persistence

- Default location: `<cwd>/.pi/handovers/<UTC-timestamp>-<slug>.md`
  (slug = sanitized one-line title, max 40 chars).
- Also maintain `<cwd>/.pi/handover.md` = copy of the latest document
  (cheap, fixed path for humans and for "read the handover" bootstrap
  prompts).
- Writing the file is best-effort: a write failure must not abort compaction.

### 2.3 Hook integration (`session_before_compact`)

Fires for all three trigger reasons: `threshold` (auto), `manual` (`/compact`),
`overflow`. For all of them:

1. Serialize doomed messages:
   `serializeConversation(convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]))`
2. Thread `previousSummary` in (iterative compactions) and any manual
   `/compact` instructions.
3. Call the **handover model** (see 2.4) to write the document.
4. Return `{ compaction: { summary: <doc>, firstKeptEntryId, tokensBefore,
   usage, details: { handoverFile } } }` where `firstKeptEntryId` defaults to
   `preparation.firstKeptEntryId` (default pi behavior: keep the recent
   turn(s)) — with a config option `keepRecent: "none"` to clear everything.
5. **Fallback is mandatory:** if generation fails, is empty, or is aborted,
   return `undefined` so pi falls back to default compaction. Never leave the
   session without a compaction entry after the hook returned.

### 2.4 Model selection

- `handoverModel` config (default: the current session model).
  Rationale: the whole point is that the *session* model may be a weak
  flash-tier model; the handover should be written by the best available
  model (e.g. a Sonnet-tier) even though the session runs on glm-flash.
- Resolution order: config override → current model (with a warning) →
  hard fallback to default compaction on failure.

### 2.5 `/handover` command

- `/handover [extra instructions]` → triggers compaction immediately
  (`ctx.compact(...)`), threading the extra instructions into the prompt.
- `/handover-dry` → generates the document, shows it, but does not compact
  (for review/debug).

### 2.6 Configuration

In `~/.pi/agent/settings.json` or project settings under `piHandoff`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Hook active at all |
| `handoverModel` | unset | Model id used for generation |
| `keepRecent` | `"default"` | `"none"` clears kept messages after compaction |
| `outputDir` | `.pi/handover` | Where documents are written |
| `maxWords` | `800` | Length cap for the document |
| `template` | built-in | Optional full prompt-template override |

## 3. Non-goals

- No session switching / new-session creation (that's `handoff.ts`'s job; we
  compact *in place* so the same session continues).
- No custom templates DSL, no telemetry, no memory systems (see rejected
  prior art in §4).
- No "smart" verification stages, multi-model consensus, or skill inventories.

## 4. Inspiration (what to take from where)

**pi shipped examples** (`/snap/pi-coding-agent/33/lib/pi/packages/coding-agent/examples/extensions/`):
- `custom-compaction.ts` — the canonical `session_before_compact` handler:
  serialization helpers, fresh `sessionId` + `cacheRetention: "none"` for the
  one-off LLM call, fallback-to-default on empty/error, returning
  `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage } }`.
- `handoff.ts` — the handover *prompt shape* ("context transfer assistant":
  decisions, files involved, next task) and the LLM-call plumbing.
- `trigger-compact.ts` — programmatic `ctx.compact()` + usage-threshold
  pattern (reference only; our hook handles auto-trigger natively).

**pi docs**:
- `docs/compaction.md` — `CompactionEntry` semantics, `firstKeptEntryId`,
  split turns, tool-result 2000-char serialization cap, settings keys.
- `docs/extensions.md` — event API, `ctx.modelRegistry`,
  placement + `/reload`.
- `docs/packages.md` — package manifest (`pi.extensions`, `pi-package`
  keyword), install/test via `pi -e npm:...`.

**Existing npm packages** (evaluated, see §5):
- `@tryinget/pi-session-compaction` — proves the hook+handoff combination;
  take the *idea* of a fresh-session-pasteable prompt, reject its ecosystem-
  specific authority-boundary machinery.
- `pi-blitz-handoff` — excellent dossier *content rules* (verified vs
  unverified work, blockers, resume-precise next step); reject its heavyweight
  protocol/template machinery.
- `pi-cc-compact` — Claude Code's 9-section compaction prompt; evidence that
  a fixed section structure works; we use 4 sections instead.

## 5. Explicitly rejected alternatives

| Alternative | Why not |
|---|---|
| Continue with default compaction | Lossy, unstructured; failed in practice (see Background) |
| `pi-blitz-handoff` | Heavy protocol; templates/authorization machinery we don't want |
| `@tryinget/pi-session-compaction` | Overfit to author's private tooling (AK/ROCS surfaces) |
| `handoff.ts` (new-session flow) | Switches sessions; we want in-place compaction |
| `billion-context-pi` style compression | Different problem (token compression vs mission handover) |

## 6. Background (why this exists)

In a real 2-day agentic run (`mysql-llm-skills` eval project, Sep 2026),
`openrouter/z-ai/glm-5.3-flash` received the full ~225k-token context (pi sent
everything; provider did not truncate — verified by needle tests to 362k) yet
behaved as if the conversation contained ~4 messages: it re-executed the
session's first task, denied completed work, and hallucinated that read
outputs were "truncated/condensed" when they were byte-identical to disk.
Root cause: flash-tier long-context integration collapse; pi never compacted
because the registry advertised a 1M window. Hence two needs: (a) a
handover-doc compaction that can be triggered deliberately, (b) the earlier
`contextWindow: 150000` model override that makes compaction fire at all.

## 7. Acceptance criteria

1. `pi -e ./extensions` loads the extension without errors.
2. With a long test session, `/compact` produces a doc containing the four
   required sections in order; session continues with that doc as context.
3. The doc is written to `.pi/handover.md` and timestamped in `outputDir`.
4. Generation failure/abort → default compaction still runs; no crash.
5. `previousSummary` content is folded into the new doc on repeated compaction.
6. `handoverModel: <stronger model>` is honored for the generation call.
7. `keepRecent: "none"` clears the kept messages (only the doc remains).
8. `tsc --noEmit` passes; no runtime deps beyond pi's built-in import set.

## 8. Open questions

- Should `/handover` also work in `--mode json`/RPC, or TUI-only (like
  handoff.ts)? Default: TUI-only, notify otherwise.
- Stamp `details: { handoverFile }` for `pi list`-style discovery?
- Include a trailing `<read-files>/<modified-files>` block in the doc (the
  default summary format has one) or rely on `details.fileOps`?