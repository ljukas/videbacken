---
name: feature-workflow
description: Videbacken's end-to-end process for building a new feature or capability, from idea to merge (shape → understand seams → plan → isolate → build task by task with adversarial review → review the branch → verify → ship). Use proactively, before any code, whenever the user asks to build, add, implement, create, or extend something that changes behavior — a new screen, procedure, service, schema, integration, or idea ("let's add…", "can we support…", "I want X to…"). Not for bugs (use bugfix-workflow) or behavior-preserving restructuring (use refactor-workflow).
argument-hint: "[feature or idea]"
---

# Feature workflow

The process lives in `docs/feature-workflow.md`, the single source of truth. This skill only loads it.

1. **Read `docs/feature-workflow.md` in full** (repo root) before doing anything else. Don't work from memory; the phases and toolchain mapping change.
2. Follow it phase by phase, starting at **Phase 0 (Shape the idea)**. For each phase, invoke the skills and agents its row in the doc's **Current toolchain mapping** table names (`Skill` / `Agent` tool). Follow links to shared sections (e.g. the pre-PR gate).
3. If the codebase fights the feature, do the preparatory refactor first under the `refactor-workflow` skill, in separate commits, then come back.

The feature to build: $ARGUMENTS

If no feature was given above, ask what the user wants to build before starting Phase 0.
