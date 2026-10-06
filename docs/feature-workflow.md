# How we build a new feature

The durable arc for taking a new feature or idea from spark to merge. This is the *meta-process* that produces the other artifacts. It is **not** an ADR (one decision), **not** a plan (one feature's build steps), and **not** a spec (one design).

Companions — one hat per commit, pick the doc by the hat:
- **[refactor-workflow.md](./refactor-workflow.md)** — behavior-preserving structural change.
- **[bugfix-workflow.md](./bugfix-workflow.md)** — observed behavior differs from intended behavior.

> **Run it:** `/feature-workflow <idea>` (`.claude/skills/feature-workflow/`) loads this doc and starts at Phase 0. Edit the process here, not in the skill.

> **Where the tools are.** The phases say *what* and *why*. *Which* skill or agent to use lives in [Current toolchain mapping](#current-toolchain-mapping): look up each phase's row there, and update that table (not the prose) when tooling changes. Entries tagged *(agent)* go through the `Agent` tool with that exact type; everything else is a skill for the `Skill` tool. Two exceptions name tools in the prose on purpose: the mandatory review gates (they're rules, not suggestions) and the [reviewer pairings](#reviewer-pairings) table.

---

## The shape in one line

**Shape → Understand the seams → Plan → Isolate → Build (task by task, each reviewed) → Review the branch → Verify → Ship.** Brainstorm at the start and verify at the end, *always*, however small the feature feels.

---

## The phases

### 0. Shape the idea
**What:** Clarify intent, scope, constraints and success criteria *before* any code. Decide the **first slice** (the smallest thing that delivers the core value) and what's explicitly deferred. Surface the open product decisions the idea glossed over. Brainstorming is mandatory, even for "obviously simple" features, because that's where unexamined assumptions surface.
**Output:** An agreed scope, and a written **design record**:
- A real *decision with alternatives* (a new seam, a non-obvious trade-off) → an **ADR** in `docs/adr/` (e.g. ADR-0019, written for the Zaptec integration).
- Design detail that isn't a decision → a **spec** in `docs/superpowers/specs/`.

**Big features → a scope map first.** When the idea spans several shippable phases, write a **scope map** (feasibility verdict per capability, then the phases), then one **design spec per phase** as you reach it. Example: `specs/2026-09-28-ev-charging-scope-map.md` → `2026-09-28-ev-charging-phase1-design.md` → `2026-09-29-ev-charging-phase2-design.md`.

**Probe external systems before designing on them.** For a new integration, make a few live calls first and write down what you actually saw. The Zaptec probe found a 24 h token lifetime (not the documented 1 h) and pinned the `energyDetails` semantics before any schema existed. Designs built on assumed API behavior get rebuilt.

**Judgment — does the codebase fight this feature?** If adding it cleanly means restructuring first, do a **preparatory refactor** ("make the change easy, then make the easy change") under [refactor-workflow.md](./refactor-workflow.md), in its own PR, then come back. Example: #23 extracted the pulled-sync lifecycle out of the Zaptec sync *before* the elpris sync reused it. Never tangle the restructure into the feature.

### 1. Understand the seams
**What:** Map what already exists that the feature will *consume or reuse*, at the line level, before replicating anything. videbacken leans hard on documented seams (services, effects, queue dispatch, pulled-sync lifecycle, forms, storage; see the ADRs), and a good design names the exact files to reuse verbatim. Dispatch several explorers in parallel when the feature touches independent seams.

**Reuse before you hand-roll** (CLAUDE.md → "How we write code"). For every non-trivial piece the design needs (retries, time zones, caching, scales, parsing), check in order:
1. an existing seam or an installed dependency in `package.json` (read its *current* docs before deciding it can't);
2. a well-maintained library;
3. hand-rolling, only if neither fits, with the reason written in the design and the PR.

**Output:** A short list of seams, dependencies and files to reuse, and the current shapes to match.
**Judgment:** *When the design is already done (a detailed ADR/spec), don't run an architect pass.* The design is the architecture; exploration + Phase 2 cover the rest. Use an architect only for blank-page design.

### 2. Plan
**What:** Turn the design + the exploration findings into a **checkpointed, layered** plan, ordered by the dependency spine:
`schema/migration (+ .enableRLS()) → services (+errors +tests) → procedures (+error mappers, timings) → effects wiring → UI → i18n`.

**Slice into PRs, one concern each.** Each PR must be shippable on its own and reviewable in one sitting. Big features become a **stack**: EV-charging phase 2 shipped as #23 (preparatory refactor) → #24 (RLS, from the schema review) → #25 (storage + pure cost math, nothing calls it yet) → #26 (spot-price sync) → #29 (cost UI + tariff admin). Put the slicing in the plan.

**Pair reviewers per task.** For each task, the plan names the two reviewers Phase 4 will dispatch (see [pairings](#reviewer-pairings)).
**Output:** A plan in `docs/superpowers/plans/`.

### 3. Isolate
**What:** Give sizable work its own git worktree so it can't bleed into the current branch. Skip only for trivial single-file features.

### 4. Build, task by task
**What:** Execute the plan **one task at a time**, each through the same loop:
1. **Implement** the task. Testable layers (services, pure helpers, effect adapters) go **test-first**: ADR-0002 mandates colocated service tests, and `test-completeness` requires every `<Entity>DomainError.code` literal to be exercised. Visual/client-only UI is built, then verified live (Phase 6).
2. **Commit** it (one hat, conventional message).
3. **Adversarial review:** dispatch **two reviewers in parallel**, each told to *start from the assumption that the task is incorrect and not up to spec*, and each wired to that layer's skills ([pairings](#reviewer-pairings)).
4. **Fix** every confirmed finding (or rule on it explicitly), then move to the next task.

This loop stays a per-task checkpoint in the conversation. Don't collapse it into one autonomous run.

**Honor the architectural rules** (CLAUDE.md → "How we write code"): services own DB access; effects run after success; logging via `~/lib/logger`; heavier RPCs record `context.timings` sub-timings; **never hold a connection open** (poll with `refetchInterval`, ADR-0018); forms via `useAppForm`. Plus the [Non-negotiables](../CLAUDE.md#non-negotiables).
**Parallelize the leaves, respect the spine.** Schema → services → procedures is sequential; pure helpers, i18n strings and static registries can be farmed out.
**When something breaks:** debug systematically, never guess-patch.

#### Reviewer pairings
| Task touches | Reviewer A | Reviewer B |
|---|---|---|
| Schema / migration | `migration-guard` | schema-design reviewer (subagent loading `supabase-postgres-best-practices`, judging against the queries that will actually run) |
| Service / `errors.ts` / effect adapter | `code-reviewer` | `test-completeness` |
| Procedure / auth / permission boundary | `code-reviewer` | reviewer loading `better-auth-security-best-practices` |
| UI component / route | `code-reviewer` | reviewer loading `web-design-guidelines` + `vercel-react-best-practices` |
| Email template | `code-reviewer` | reviewer loading `react-email` + `email-best-practices` |

### 5. Review the branch
**What:** The per-task reviews catch local mistakes; this pass catches what only shows across the whole diff. **It must finish before merge**, and its findings are fixed *in this PR*. #21 merged before its multi-agent review finished, and #22 had to fix 10 findings after the fact, including a sync that could fail silently.
**Gates** (the schema one is a Non-negotiable; the rest are house rules):
- Schema or `drizzle/` changed → `migration-guard` **and** the schema-design review, with every finding fixed or explicitly ruled on (Non-negotiable).
- Service / effect / `errors.ts` changed → `test-completeness`.
- Always → `code-reviewer` (ADR adherence) plus a general correctness pass, scaled to the diff.
- Auth, sessions, file access or permission boundaries → a dedicated security pass. The `security-guidance` plugin also reviews continuously and at commit/push; address or consciously dismiss its findings.

Receive feedback with rigor: verify each finding, don't perform agreement.

### 6. Verify end-to-end
**What:** Evidence before any "done" claim. Run the [pre-PR gate](#pre-pr-gate). For **visual/client-only** features (the payoff is something you *see*), drive the real app in a browser at desktop, tablet and mobile widths.

### 7. Ship
**What:** Integrate the finished, green work: open the PR with `.github/PULL_REQUEST_TEMPLATE.md` (short *why* + ADR link, checklist ticked with real evidence) and squash-merge. The PR title is the conventional-commit subject.
**Loop-back:** if the work changed a decision, amend the ADR (or add one) and update CLAUDE.md "Decisions made".

---

## Pre-PR gate

Shared by all three workflows. It mirrors CI (the `CI Success` gate over `Check (lint)`, `Check (types)`, `Check (build)`, `Test (node 1/2)`, `Test (node 2/2)` and `Test (browser)`, plus the PR-title lint) and adds the checks CI can't do:

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```
- **UI changed:** checked responsive at desktop, tablet and mobile widths in a real browser.
- **PR title:** `<type>(<scope>): <subject>`, ≤72 chars, imperative, and one concern.

Paste the output (or say what you checked) in the PR's *Verification* section. Unchecked boxes are claims, not evidence.

---

## Recurring judgment calls

- **Design done → skip the architect.** A detailed ADR/spec already *is* the architecture; spend the budget on real seams and a tight plan.
- **TDD fits the testable layers, not all of them.** Services, pure functions, adapters: test-first. Visual UI: build, then verify live.
- **Project agents beat a generic reviewer on project footguns** (migrations, domain-error coverage, ADR adherence).
- **Skeptical reviewers, not confirming ones.** Tell reviewers to assume the work is wrong; an optimistic pass misses off-spec work.
- **The codebase fights you → switch hats first.** Preparatory refactor in its own PR, *then* the feature.
- **Reuse, then a library, then hand-roll.** Hand-rolled retry/time/cache code became a refactor backlog; don't add to it.

---

## Which artifact am I producing?

| Artifact | Captures | Lives in |
|---|---|---|
| **ADR** | A decision *with alternatives* and why; a new seam | `docs/adr/NNNN-*.md` |
| **Scope map** | Feasibility + phase breakdown for a multi-phase feature | `docs/superpowers/specs/*-scope-map.md` |
| **Spec** | Design detail for one phase that isn't a standalone decision | `docs/superpowers/specs/` |
| **Plan** | The checkpointed build sequence + PR slicing for one phase | `docs/superpowers/plans/` |
| **Workflow** | The reusable process (this doc, refactor, bugfix) | `docs/*-workflow.md` (run via `.claude/skills/*-workflow/`) |

---

## Current toolchain mapping

*Where tools are listed (the prose names only mandatory gates). Entries tagged* (agent) *go through the `Agent` tool; the rest are skills. Update this section when tooling changes; the phases above stay durable.*

| Phase | Primary | Also useful |
|---|---|---|
| 0. Shape | `superpowers:brainstorming` | `AskUserQuestion` for genuine forks; Context7 (API docs) + live calls for integration probes |
| 1. Understand seams | `feature-dev:code-explorer` *(agent)* | `Explore` *(agent)*; `superpowers:dispatching-parallel-agents`; Context7 (installed-library docs); `find-skills` *(user-level)*; `feature-dev:code-architect` *(agent; blank-page design only)* |
| 2. Plan | `superpowers:writing-plans` | `Plan` *(agent; smaller features)* |
| 3. Isolate | `superpowers:using-git-worktrees` | — |
| 4. Build | `superpowers:subagent-driven-development` (this session) / `superpowers:executing-plans` (inline, no subagents) | `superpowers:test-driven-development`; `superpowers:systematic-debugging`; `superpowers:dispatching-parallel-agents` *(leaves)*; `ralph-loop:ralph-loop` *(only a task whose tests are already written: the prompt says to print `<promise>DONE</promise>` only once the suite and `check:ci` are green; run with `--completion-promise DONE --max-iterations N`)*; reviewers per [pairings](#reviewer-pairings); domain skills: `shadcn`, `vercel-react-best-practices`, `vercel-composition-patterns`, `supabase-postgres-best-practices`, `better-auth-best-practices`, `better-auth-security-best-practices`, `react-email`, `email-best-practices`, `frontend-design`, `web-design-guidelines` |
| 5. Review branch | `code-reviewer`, `migration-guard`, `test-completeness` *(agents)*; schema-design reviewer *(`general-purpose` agent loading `supabase-postgres-best-practices`)* | `/code-review` (`high`+ for large diffs; `--fix` to apply); `/security-review`; `security-guidance` *(automatic)*; `superpowers:requesting-code-review` / `superpowers:receiving-code-review`; the `Workflow` tool for a multi-agent review *(only when the user opts in)* |
| 6. Verify | `superpowers:verification-before-completion` | `/run`; `claude-in-chrome` or the `playwright` plugin (drive the browser, resize for responsive); `vercel:verification` *(user-level plugin)* |
| 7. Ship | `superpowers:finishing-a-development-branch` | `security-guidance` *(commit/push review)*; `claude-md-management:revise-claude-md` *(capture session learnings)* |
