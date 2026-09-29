---
name: feature-workflow
description: Videbacken's end-to-end process for building a new feature or capability, from idea to merge (shape → understand seams → plan → isolate → build layer by layer → review → verify → ship). Use proactively, before any code, whenever the user asks to build, add, implement, create, or extend something that changes behavior — a new screen, procedure, service, schema, integration, or idea ("let's add…", "can we support…", "I want X to…"). Not for bugfixes or pure restructuring; for behavior-preserving change use refactor-workflow.
argument-hint: "[feature or idea]"
---

# Feature workflow

The process lives in `docs/feature-workflow.md`, the single source of truth. This skill only loads it.

1. **Read `docs/feature-workflow.md` in full** (repo root) before doing anything else. Don't work from memory; the phases and toolchain mapping change.
2. Follow it phase by phase, starting at **Phase 0 (Shape the idea)**. Invoke each phase's named skill or agent via the `Skill` / `Agent` tool as the doc says.
3. If the codebase fights the feature, do the preparatory refactor first under the `refactor-workflow` skill, in separate commits, then come back.

The feature to build: $ARGUMENTS

If no feature was given above, ask what the user wants to build before starting Phase 0.
