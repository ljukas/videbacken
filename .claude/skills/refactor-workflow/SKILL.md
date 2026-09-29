---
name: refactor-workflow
description: Videbacken's process for behavior-preserving structural change (confirm & size → safety net → decide the target → pick a strategy → isolate → small steps → verify preservation → review & ship), with one hat per commit. Use proactively, before editing, whenever the user asks to refactor, restructure, clean up, simplify, extract, move, rename, consolidate, deduplicate, deepen, or migrate existing code or an adapter, or replace hand-rolled code with a library, without changing what it observably does — and when a feature needs a preparatory refactor first. For adding capability use feature-workflow; for wrong behavior use bugfix-workflow.
argument-hint: "[code or area to refactor]"
---

# Refactor workflow

The process lives in `docs/refactor-workflow.md`, the single source of truth. This skill only loads it.

1. **Read `docs/refactor-workflow.md` in full** (repo root) before doing anything else. Don't work from memory; the phases and toolchain mapping change.
2. Follow it phase by phase, starting at **Phase 0 (Confirm it's a refactor, and size it)**. For each phase, invoke the skills and agents its row in the doc's **Current toolchain mapping** table names (`Skill` / `Agent` tool). Follow links into `docs/feature-workflow.md` for shared sections (pre-PR gate, per-task review loop).
3. Keep to the prime directive: **one hat per commit**. If the change alters behavior, stop and switch to the `feature-workflow` or `bugfix-workflow` skill.

The refactor target: $ARGUMENTS

If no target was given above, ask what the user wants to refactor before starting Phase 0.
