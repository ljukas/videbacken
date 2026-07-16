# How we build a new feature

The durable arc for taking a new feature or idea from spark to merge. This is the *meta-process* that produces the other artifacts — it is **not** an ADR (those record one decision), **not** a plan (those sequence one feature's build steps), and **not** a spec (those capture one design). It's the recipe those follow.

Companion: **[refactor-workflow.md](./refactor-workflow.md)** for behavior-preserving structural change. If your task adds capability, you're in the right doc. If it only rearranges existing behavior, switch there.

> **How to read the skill callouts.** Each phase names the skill/agent to reach for. Phase names are durable; the *specific tools* are listed once in [Current toolchain mapping](#current-toolchain-mapping) — when tooling changes, update that one section, not the prose. Invoke a skill via the `Skill` tool; dispatch an agent via the `Agent` tool.

---

## The shape in one line

**Shape → Understand the seams → Plan → Isolate → Build (layer by layer) → Review → Verify → Ship.** Brainstorm at the start, verify at the end — *always*, regardless of how small the feature feels.

---

## The phases

### 0. Shape the idea
**What:** Clarify intent, scope, constraints, and success criteria *before* any code. Decide the **first slice** (the smallest thing that delivers the core value) and what's explicitly deferred. Surface the open product decisions the idea glossed over.
**Output:** An agreed scope, and a written **design record**:
- A real *decision with alternatives* (a new seam, a non-obvious trade-off) → an **ADR** in `docs/adr/`. This is how every substantial oceanview feature starts (ADR-0010, 0012, 0017).
- Design detail that isn't a decision → a lightweight **spec** (brainstorming's default output location).
**Skill:** `superpowers:brainstorming` — mandatory, even for "obviously simple" features; that's where unexamined assumptions surface. It ends by handing off to planning.
**Judgment:** *Does the codebase already fight this feature?* If adding it cleanly would mean restructuring first, that restructuring is a **preparatory refactor** — "make the change easy, then make the easy change." Do it under [refactor-workflow.md](./refactor-workflow.md) **first**, in separate commits, then come back here. Never tangle the restructure into the feature.

### 1. Understand the seams
**What:** Map what already exists that the feature will *consume or reuse*, at the line level, before replicating anything. oceanview leans hard on documented seams (storage, realtime, queue, services, forms — see the ADRs); a good design names the exact files to reuse "verbatim."
**Output:** A short list of files/patterns to reuse and the current shapes to match.
**Skills:**
- `feature-dev:code-explorer` (agent) — trace execution paths and map the current shape of a subsystem you'll build on. **This is feature-dev's highest-value step here**, because our ADRs reference seams by name ("reuse the avatar flow", "follow the document/folder error pattern") and you need their real, current code first.
- `Explore` (agent) — lighter, for "where does X live / what's the naming convention" sweeps.
- Dispatch several in parallel when the feature touches several independent seams.
**Judgment:** *When the design is already done (a detailed ADR), skip feature-dev's `code-architect`.* The ADR is the architecture; explorer + Phase 2 cover the rest. Reach for `code-architect` only when you're designing from a blank page.

### 2. Plan
**What:** Turn the design (ADR/spec) + the exploration findings into a **checkpointed, layered** implementation plan, ordered by the dependency spine:
`schema/migration → services (+errors +tests) → procedures (+error mappers) → effects wiring → UI → i18n`.
**Output:** A plan in `docs/plans/<feature>/` (see the `redesign-2026-06/` precedent), with explicit review checkpoints between layers.
**Skills:** `superpowers:writing-plans` (the architect role for a designed feature); `Plan` (agent) as a lighter alternative for smaller features.

### 3. Isolate
**What:** Give sizable work its own workspace so it can't bleed into the current branch.
**Skill:** `superpowers:using-git-worktrees`. Skip only for trivial single-file features.

### 4. Build, layer by layer
**What:** Execute the plan one layer at a time, honoring the **five architectural rules** (CLAUDE.md → "How we write code": services own DB access; effects after success; logging via `~/lib/logger`; realtime via `realtime.publish`; forms via `useAppForm`) and the [Non-negotiables](../CLAUDE.md#non-negotiables).
**Skills:**
- `superpowers:executing-plans` — drive a written plan with review checkpoints (separate session).
- `superpowers:subagent-driven-development` — same, farming independent tasks to subagents in this session.
- `superpowers:dispatching-parallel-agents` — for the independent leaves (pure helpers, i18n strings, static registries) that don't sit on the dependency spine.
- **Testable layers → `superpowers:test-driven-development`.** Services and pure helpers get tests first (ADR-0002 mandates service tests). Every `<Entity>DomainError.code` literal must be exercised.
- **Un-testable layers (client-only/WebGL/visual UI) → build then verify live** (Phase 6), not TDD.
- `ralph-loop:ralph-loop` — **optional**, only for a well-scoped layer with an *automatic* success criterion (a TDD'd service whose failing test suite is already written): run an autonomous loop with `--completion-promise` tied to a green suite + `pnpm check`, and **always** set `--max-iterations` as a backstop. Write the tests first; the loop's output is still subject to one-hat-per-commit and small, reviewable diffs. Never for the design/judgment phases (0–2).
- `superpowers:systematic-debugging` the moment something breaks — never guess-patch.
- **Domain/library skills as you touch each area** — consult the CLAUDE.md **"Skill loading — when to load which"** router table (it maps task → skill/ADR). High-value ones: `shadcn` / `vercel:shadcn` (UI components), `vercel:react-best-practices` + `vercel-composition-patterns` (component structure), `supabase-postgres-best-practices` / `neon-postgres` (schema, queries, indexes), `better-auth-best-practices` + `better-auth-security-best-practices` (auth), `react-email` + `email-best-practices` (templates), `frontend-design` / `web-design-guidelines` (visual + UX/accessibility).

### 5. Review
**What:** Review each slice as it lands. The **project-specific agents catch what a generic reviewer misses** and come first:
- `migration-guard` — run it whenever `drizzle/` or `src/lib/db/schema/` changed (missing `--name=`, timestamptz `USING … AT TIME ZONE`, destructive ops, `betterAuth.ts` hand-edits).
- `test-completeness` — after any service/effect/`errors.ts` change; enforces ADR-0002's "every domain-error code is tested."
- `code-reviewer` — the oceanview ADR-aware reviewer (avatar pattern, code-only error mapping, realtime conventions).
- `/security-review` — the on-demand deep pass for auth, file-access, or anything touching session/permission boundaries. The `security-guidance` plugin (enabled in `.claude/settings.json`) now *also* runs **automatically** — pattern warnings on edits, an LLM diff review when a turn ends, and an agentic multi-file review at commit/push — so security feedback appears continuously through Build → Ship; `/security-review` stays the explicit, focused pass for sensitive boundaries.
**Skills:** `superpowers:requesting-code-review` to frame the request; `superpowers:receiving-code-review` to act on feedback with rigor (verify, don't perform agreement). `feature-dev:code-reviewer` / `/code-review` for general correctness passes.

### 6. Verify end-to-end
**What:** Evidence before any "done" claim. Run the suite and the verification commands; for **visual/client-only** features (the payoff is something you *see*), verify in a real browser.
**Skills:** `superpowers:verification-before-completion` (the discipline); `/verify` or `vercel:verification` (run the app, observe behavior); `/run` (launch it); `claude-in-chrome` (drive the browser for visual confirmation).

### 7. Ship
**What:** Integrate the finished, green work.
**Skill:** `superpowers:finishing-a-development-branch` (merge / PR / cleanup). Conventional Commits per the [Non-negotiables](../CLAUDE.md#non-negotiables).
**Note:** committing/pushing triggers `security-guidance`'s agentic multi-file review (IDOR, auth-bypass, cross-file SSRF); address or consciously dismiss any findings before opening the PR.

---

## Recurring judgment calls

- **Design done → skip the architect.** A detailed ADR already *is* the architecture; spend the budget on exploring real seams and a tight plan, not re-deriving the design.
- **TDD fits the testable layers, not all of them.** Services and pure functions: test-first. Client-only WebGL / visual UI: build-and-verify-live.
- **Project agents > generic reviewer for project footguns** (migrations, domain-error coverage, ADR adherence).
- **Parallelize the leaves, respect the spine.** Schema → services → procedures is sequential; pure helpers, i18n strings, and static registries are not.
- **The codebase fights you → switch hats first.** Preparatory refactor under [refactor-workflow.md](./refactor-workflow.md), separate commits, *then* build the feature.

---

## Which artifact am I producing?

| Artifact | Captures | Lives in |
|---|---|---|
| **ADR** | A decision *with alternatives* and why; a new seam | `docs/adr/NNNN-*.md` |
| **Spec** | Design detail that isn't a standalone decision | brainstorming default (`docs/superpowers/specs/`) |
| **Plan** | The checkpointed build sequence for one feature | `docs/plans/<feature>/` |
| **Workflow** | The reusable process (this doc + the refactor one) | `docs/*-workflow.md` |

---

## Current toolchain mapping

*Update this section when tooling changes; the phases above stay durable.*

| Phase | Primary | Also useful |
|---|---|---|
| 0. Shape | `superpowers:brainstorming` | ADR in `docs/adr/`; `AskUserQuestion` for genuine forks |
| 1. Understand seams | `feature-dev:code-explorer` | `Explore`; `dispatching-parallel-agents` |
| 2. Plan | `superpowers:writing-plans` | `Plan`; `feature-dev:code-architect` (blank-page only) |
| 3. Isolate | `superpowers:using-git-worktrees` | — |
| 4. Build | `superpowers:executing-plans` / `subagent-driven-development` | `test-driven-development`; `systematic-debugging`; `dispatching-parallel-agents`; `ralph-loop` *(auto-verifiable layers only)*; CLAUDE.md skill-loading table (`shadcn`, `vercel:react-best-practices`, `vercel-composition-patterns`, `supabase-postgres-best-practices`, `neon-postgres`, `better-auth-*`, `react-email`, `frontend-design`) |
| 5. Review | `code-reviewer`, `migration-guard`, `test-completeness` | `requesting-`/`receiving-code-review`; `/code-review`; `/security-review` + `security-guidance` *(automatic)*; `feature-dev:code-reviewer` |
| 6. Verify | `superpowers:verification-before-completion` | `/verify`; `vercel:verification`; `/run`; `claude-in-chrome` |
| 7. Ship | `superpowers:finishing-a-development-branch` | `security-guidance` *(commit/push review)* |
