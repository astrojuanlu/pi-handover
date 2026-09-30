# pi-handover

![Warning: Vibe Coded](https://img.shields.io/badge/%E2%9A%A0%EF%B8%8F_warning-vibe_coded-orange?style=flat)
[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/@astrojuanlu/pi-handover)](https://npmx.dev/package/@astrojuanlu/pi-handover)

Handover-document compaction for the [pi coding agent](https://pi.dev). When
pi compacts your context, instead of a lossy rolling summary you get a
structured **handover document** — *Mission / What has been done / What we
have learned / What is next* — which becomes the model's entire visible
context and is also persisted to disk.

## Why

pi's default compaction generates a token-efficient rolling summary and keeps
the last ~20k tokens. That works fine for strong models, but weak/flash-tier
models at very long real-world agentic contexts confabulate long before any
mechanism intervenes: they claim reads were "truncated", deny completed work,
and re-execute the session's first task. When the context must be cleared, we
want the agent to first write a handover document with a fixed, predictable
structure — like a competent colleague briefing a replacement — and then have
that document be its entire visible history.

## Install

```bash
# from a local checkout
pi install /absolute/path/to/pi-handover
# or, once published
pi install npm:@astrojuanlu/pi-handover
```

Or try it in place:

```bash
pi -e ./extensions
```

## Commands

| Command | Behavior |
|---|---|
| `/handover [extra instructions]` | Write the handover document and compact in place (same session continues). Extra instructions are threaded into the handover prompt. |
| `/handover-dry [extra instructions]` | Generate + show the document for review. Nothing is compacted. (TUI only.) |
| `/compact [instructions]` | Also produces a handover document — the hook replaces the default summary for all compaction triggers (`manual`, `threshold`, `overflow`). |

Note: this is deliberately different from pi's `handoff.ts` example (new-session
transfer) — `/handover` compacts *in place* so the same session continues.

## What gets written

The document has exactly four sections, in this order:

```markdown
# Handover — <one-line task title> (<ISO date>)

## Mission
## What has been done
## What we have learned
## What is next
```

It is persisted to:

- `<cwd>/.pi/handovers/<UTC-timestamp>-<slug>.md` — one file per compaction
- `<cwd>/.pi/handover.md` — copy of the latest document (fixed path, easy to
  reference in a bootstrap prompt)

Every document also carries a trailing **handover boundary note** telling the
successor model that messages newer than the document follow it in context —
so "What is next" is a checklist to verify against those messages, not a
queue to redo.

Writes are best-effort: a write failure never aborts compaction.

## Configuration

In `~/.pi/agent/settings.json` (global) or `<project>/.pi/settings.json`
(project wins, honored only for trusted projects), under `piHandover`:

```json
{
  "piHandover": {
    "enabled": true,
    "handoverModel": "google/gemini-2.5-flash",
    "outputDir": ".pi/handovers",
    "maxWords": 800
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Hook active at all. |
| `handoverModel` | *(session model)* | Model id used to write the document. The whole point: the *session* model may be a weak flash-tier model; let the best available model write the handover. Bare ids (`google/gemini-2.5-flash`) resolve to your configured providers; a warning is emitted when the session model is used as fallback. |
| `outputDir` | `.pi/handovers` | Where timestamped documents are written (relative to cwd). |
| `maxWords` | `800` | Length cap for the document. |
| `template` | built-in | Full prompt-template override. Placeholders: `{conversation}`, `{fileInventory}`, `{previousHandover}`, `{extraInstructions}`, `{maxWords}`. The four-section structure is still enforced by validation. |

## Visibility in the TUI

The handover document is visible in the chat transcript in two places:

- pi itself renders every compaction as a collapsible `[compaction]` block
  (`Compacted from N tokens`; `ctrl+o` expands it).
- The extension additionally appends a TUI-only `[handover]` block right
  after the compaction — labeled with the document title and the file path,
  expanding to the full document under `ctrl+o`. It mirrors pi's own
  compaction-summary component (same colors, same collapse semantics) and,
  being a custom entry, **never enters the model context** — the document
  reaches the model only through the compaction summary.

## Fallback guarantee

If generation fails, is empty, is aborted, or the document is missing one of
the four sections, the hook returns control and **pi's default compaction
runs** — the session is never left without a compaction entry. Failures are
reported as warnings.

## Development

```bash
nvm use            # node 24 (see .nvmrc)
npm install
npm run typecheck  # tsc --noEmit
npm test           # node --test (unit + offline faux-provider e2e)
pi -e ./extensions # try in a scratch pi session
```

## Status

Implemented per SPEC.md; acceptance criteria in SPEC.md §7 verified
end-to-end (hook, persistence, iterative `previousSummary` folding,
`handoverModel` resolution, fallback-to-default).

## Explanation

### No reset — how in-place compaction saves context

Nothing is lost or restarted. A pi session is a tree of entries in one JSONL
file. Compaction **appends** a new entry (`CompactionEntry`) as a child of the
current leaf and advances the leaf. It deletes nothing:

```
Before:   [hdr] [user1] [asst1] [user2] [asst2] ... [userN] [asstN]   ← leaf
After:    [hdr] [user1] ... [userN] [asstN] [COMPACTION]              ← leaf
```

The `CompactionEntry` stores: the handover document (`summary`),
`firstKeptEntryId`, `tokensBefore`, the writer-model `usage`, and extension
details (`{ handoverFile, promptVersion }`).

### How "saving context" works

The saved context lives in two layers:

1. **In-session (what the model sees):** pi doesn't send the whole branch to
   the LLM. Every subsequent request rebuilds context via
   `buildSessionProjection` / `buildContextEntries`: once a compaction entry
   is on the path, entries older than `firstKeptEntryId` are **omitted from
   projection**, and the compaction entry is projected as a single
   `compactionSummary` message near the front, followed by the kept entries.
   So the handover doc literally *becomes* the visible history.

   Because projection, not deletion, is the mechanism, the old turns still
   exist — `/tree` can navigate back to them, and a repeated compaction can
   even re-summarize spans starting from the previous `firstKeptEntryId`
   (that's why `previousSummary` folding works: doc #2 merges doc #1).

2. **On disk (what survives session loss):** the same document is written to
   `.pi/handovers/<ts>-<slug>.md` plus the fixed `.pi/handover.md`. These are
   plain markdown a human (or a fresh session's bootstrap prompt) can read
   even if the JSONL is gone.

### Contrast with `handoff.ts`

| | `handoff.ts` (pi example) | our `/handover` |
|---|---|---|
| Session | **Creates a new session file** with a parent pointer, generates a kickoff prompt, you switch into it | **Same session file continues** |
| Mechanism | Session replacement (`ctx.newSession`) | Appended `CompactionEntry` + context projection |
| Old turns | Left behind in the old file | Still in the same file, just not projected to the LLM |
| Resumption | You start "fresh" with a prompt | The agent keeps its session id, name, tools state; only the visible history shrinks |

The practical effect: token usage drops to roughly the size of the handover
doc plus the kept recent turns, the model behaves "as
if freshly briefed," and there's no session switch, no lost file paths, no new
session entry in `/resume`.
