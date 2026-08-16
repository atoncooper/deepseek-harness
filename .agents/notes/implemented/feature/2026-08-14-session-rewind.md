# Agent Note: User rewind — in-place logical time travel on the session surface

Status: implemented

English | [中文](2026-08-14-session-rewind.zh.md)

## Problem

A user cannot roll a conversation back. The event-sourced log is append-only, so "rewind to that message" has no product shape: [fork](../../implemented/feature/2026-06-30-session-store-fork-api.md) copies the prefix into a NEW session and changes the conversation id, compaction rewrites the visible surface irreversibly from the model's context, and no operation redefines where the current session's history ends. Claude Code's message-level checkpoints make rollback the safety net that lets users let agents run long; without it, every mistaken direction is paid for in full.

The missing primitive is a durable, in-place redefinition of the visible history head: keep the append-only log untouched, mark "effective history ends at seq N", and let later appends continue after the marker. Because the harness derives model history from the log, the marker must be a session event the surface fold understands, and the voided future must remain readable as a branch.

## Decision

The core `SessionEventMap` carries a log-only `session/rewind` event, the surface projection treats it as a rebase, `SessionStore.rewind` appends the marker plus a model-visible notice, and the Host `session.rewind` RPC wires it end to end with a Web rewind action on completed turn tails.

### Core mechanics

- **Event vocabulary.** `session/rewind` carries `{ checkpointSeq, note? }` and is log-only (no `surfaceOp`, produces no LLM message). It is NOT `ignorable`: a reader that does not know the type refuses to reconstruct the log, because silently skipping the marker would restore the voided span — the same required-event class as `session/end-seed`. There is no `SESSION_FORMAT_VERSION` bump: the header, envelope, and surface mechanism are unchanged, and the unknown-type guard covers the new vocabulary.
- **Projection.** `foldSurface` and the incremental `SurfaceManager` rebuild fold state from the checkpoint prefix when they meet a rewind event, so the visible surface becomes the fold of events `[0, checkpointSeq]`, the voided span `(checkpointSeq, rewind seq)` stops contributing nodes but stays in the log, and appends after the marker continue normally. Nested rewinds inside a prefix rebase again (the fold of `[0, checkpoint]` is the surface at that checkpoint, which may itself contain an earlier rewind). A compaction inside the voided span never applies, so rewinding before a compaction boundary restores the original messages. The manager's `rewindGeneration` increments on every rebase, so `Session.deriveMessages` cache invalidation does not rely on the replacement count (which can be unchanged across a rewind).
- **Store operation.** `SessionStore.rewind(source, boundary, { note? }?)` mirrors `fork`'s validation: resolve the live source, require the inclusive `boundary` to exist and the prefix up to it to end outside an open turn, and require the append-time tail to be outside an open turn (callers cancel a running agent first — the loop numbers turns from the FULL log, so post-rewind turns stay consistent with the invariant without loop changes). It appends the marker plus a model-visible notice `user/message` (source kind `rewind`, text pinned in `buildRewindNotice`), so the next request sees the rebased history and a record of the rewind ("model-visible means logged").
- **Invariant.** The `dsh-session/invariant` companion rejects a rewind whose `checkpointSeq` is not an earlier event and a rewind appended while a turn is open at that position.
- **Host RPC and client.** The `session.rewind` RPC mirrors fork's anchor-to-boundary mapping (the first `turn/end` at or after the anchor, falling back to the last completed turn), cancels a running agent (`agent.cancel` with `keepInbox: false`, then `whenIdle`) so the tail closes, calls `ctx.sessions.rewind` on the live session, and flushes before resolving. The Web client renders a rewind action on every completed turn tail (`MessageIconActions` rewind button → `apply.rewindAt` → `ISessions.rewind` → `session.rewind` wire); the conversation re-renders from the appended marker and notice frames. Work in the voided span is not deleted.

## Alternatives considered

- **Fork-as-rewind (product-only).** Ship "Rewind to here" as a renamed fork: new session id, prefix seed, lineage child. Zero core changes, but the conversation identity changes, the user cannot continue "the same" session, and every rewind multiplies sessions — it is a stepping stone for UX validation, not the feature.
- **Physical truncation in place.** Delete the voided events and keep the session id. Violates the append-only contract the whole product builds on (replay, telemetry, subagent `parentSession` context, session-log-export, audit) and was rejected repeatedly for interrupted turns; a log that silently loses bytes is not the harness.
- **A mutable "head pointer" outside the log.** Store the effective head in session metadata. Breaks replay determinism and the reconstructable-request invariant: the model-visible history would depend on state that is not in the log.
- **Model-facing rewind tool.** Rewind is a user action with side effects on running agents; a tool the model can call at will would let the agent erase its own history. The Host owns the operation.

## Consequences

- **Turn numbering after rewind** stays consistent only because the loop derives the next turn from the last `turn/start` in the FULL log; a future loop that derives it from the visible head must be checked against the invariant.
- **The voided span remains in every consumer's view of the raw log** (telemetry, exports, session query); consumers that project a human transcript must keep using append-origin events and may see rewound conversations as prefix + branch.
- **Rewind through compaction** restores shadowed messages; this depends on the persistence backends retaining shadowed events (compaction rewrites the surface, not the store), and the rewind spec pins that retention explicitly.
- **Mid-turn rewinds are rejected** at the store and invariant; a future UX that wants them must relax both together and reconcile the loop's open-turn state first.
- **Deferred**: keyless snapshot coverage (rewind → continue → model sees the notice; rewind before compaction restores originals) lands with the assembled web snapshot lane; a boundary node at the rewind point and a branch view over voided spans are not yet rendered; the rewind action has no confirmation dialog before it cancels a running agent.
