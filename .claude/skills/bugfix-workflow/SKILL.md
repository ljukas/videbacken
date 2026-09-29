---
name: bugfix-workflow
description: Videbacken's process for fixing a bug (confirm & gather evidence → reproduce → root cause → failing regression test → minimal fix → verify → review & ship), with one hat per commit. Use proactively, before changing code, whenever the user reports something broken, wrong, crashing, slow, or failing — an error, a regression, a failing test or CI job, a prod incident, a bad value on screen, or review findings to fix ("X doesn't work", "why does…", "fix…", "this broke"). For new capability use feature-workflow; for pure restructuring use refactor-workflow.
argument-hint: "[symptom or bug report]"
---

# Bugfix workflow

The process lives in `docs/bugfix-workflow.md`, the single source of truth. This skill only loads it.

1. **Read `docs/bugfix-workflow.md` in full** (repo root) before doing anything else. Don't work from memory; the phases and toolchain mapping change.
2. Follow it phase by phase, starting at **Phase 0 (Confirm it's a bug, and gather evidence)**. For each phase, invoke the skills and agents its row in the doc's **Current toolchain mapping** table names (`Skill` / `Agent` tool). Follow links into `docs/feature-workflow.md` for shared sections (the pre-PR gate).
3. Keep to the prime directive: **one hat per commit**. If the fix needs restructuring, land it first under the `refactor-workflow` skill; if intended behavior was never decided, switch to the `feature-workflow` skill.

The bug: $ARGUMENTS

If no bug was given above, ask what's broken before starting Phase 0.
