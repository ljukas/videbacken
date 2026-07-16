# How we refactor

The durable arc for **behavior-preserving structural change** — making code easier to understand and cheaper to change *without changing what it observably does*.

Companion: **[feature-workflow.md](./feature-workflow.md)** for adding capability. The two are governed by one rule:

> **The prime directive — one hat at a time (Kent Beck's "Two Hats").**
> A refactor changes *internal structure only*; observable behavior stays identical and tests stay green throughout (Fowler). Adding a feature or fixing a bug is the *other* hat. **Never wear both in the same commit.** If your change alters behavior, it isn't a refactor — it belongs in [feature-workflow.md](./feature-workflow.md) (or is a bugfix). Keep refactor commits pure so any diff is *all-structure* or *all-behavior*; that's what makes review and rollback tractable.

> **How to read the skill callouts.** Phase names are durable; the specific tools live once in [Current toolchain mapping](#current-toolchain-mapping) — update that section when tooling changes, not the prose.

---

## The shape in one line

**Confirm & size → Safety net → Decide the target → Pick a strategy → Isolate → Small steps → Verify preservation → Review & ship.** Tests first, evidence at the end.

---

## The phases

### 0. Confirm it's a refactor, and size it
**What:** Two checks. (1) *Behavior-preserving?* If you're adding capability or fixing a bug, stop — wrong doc. (2) *How big?*
- **Opportunistic** (the campsite rule — "leave it better than you found it") — a bounded cleanup in code you're already touching. This is the **default**; it needs no ceremony beyond the safety net and one-hat discipline.
- **Planned / large** — a structural change big or risky enough to need a named strategy (Phase 3) and usually a plan. The exception, not the rule. (Fowler: a team refactoring well "should hardly ever need to plan refactoring.")
**Skill:** `improve-codebase-architecture` — find *deepening* opportunities informed by the ADRs (what to consolidate, where modules are shallow). Use it to discover/scope work; it speaks the house vocabulary (deep modules, the deletion test).

### 1. Establish the safety net — *first*
**What:** You can only *assert* behavior was preserved if a trustworthy test suite says so. Before touching structure, get to green.
- Covered code → confirm the relevant tests are green and meaningful.
- **Untested legacy → write characterization / approval tests first** (Feathers): feed inputs, capture whatever the code *actually* does today (bugs included — you're pinning *what is*, not *what should be*), assert future runs match. These both protect you *and* build the understanding you need.
**Rule:** **no safety net → no refactor.** Refactoring code you can't verify is editing-and-hoping.
**Skills:** `superpowers:test-driven-development` (the test-first discipline; here applied to characterization tests); `feature-dev:code-explorer` / `Explore` to understand current behavior before you pin it.

### 2. Decide what to refactor *toward*
**What:** A refactor needs a destination, and ours is the vocabulary the ADRs already use — **John Ousterhout's *A Philosophy of Software Design***:
- **Deepen modules** — powerful functionality behind a *simple* interface; push complexity *down*, not sideways into more small classes.
- **Hide information** — each module hides a decision (format, algorithm, dependency); target *information leakage* (one decision smeared across modules).
- **Reduce complexity** = reduce **dependencies** and **obscurity** — the two things that make change hard. "Does this lower net complexity?" is the acceptance test for the refactor.
- **Define errors out of existence** — redesign an API so an edge case *can't arise* rather than making every caller handle it (a no-op delete on a missing item, a clamping substring). A deepening move when you see the same error handled at many call sites.
- **The deletion test** (house idiom) — if you deleted this module, would complexity reconcentrate elsewhere? If not, it's *shallow* and shouldn't exist.
**Judgment — design is a human call:** this is the one phase AI agents are *weak* at (they rearrange more than they deepen). Decide the target with judgment; use agents to execute the mechanics (Phase 5).

### 3. Pick a strategy sized to the risk
**Small / local** → just take small steps (Phase 5). Catalog moves: Extract/Inline Function, Move, Rename, Replace Conditional with Polymorphism.

**Large / risky** → pick a named strategy so the codebase stays shippable throughout:

| Strategy | What it is | Use when |
|---|---|---|
| **Mikado Method** | Attempt the change; when it breaks, note the prerequisite, **revert**, recurse into a dependency graph; then execute leaves-first, each landing on green `main`. | Many tangled, *unknown* prerequisites; you want to avoid a branch that's broken for weeks. |
| **Strangler Fig** | Route through a facade, build the replacement behind it piece by piece, redirect gradually, delete the old once nothing routes to it. | Migrating a subsystem or **swapping an adapter/provider** — directly the ADR-0006 R2 storage swap and ADR-0012 tile-provider swap. |
| **Branch by Abstraction** | Introduce an abstraction in front of the thing, migrate all callers to it, build the new impl behind it, flip the default, delete the old. | Replacing something **many call sites depend on** (a shared lib, internal API, the data layer). |
| **Parallel Change** (expand → migrate → contract) | Add the new form alongside the old, move all callers/data over, then remove the old. | Changing a **widely-used interface, schema, or DB column** you can't update atomically. (For DB: pairs with the project's additive-migration discipline.) |

(*Mechanism note:* feature flags / a parallel run that compares old-vs-new output are how cutovers stay reversible.)
**Skills:** `superpowers:writing-plans` for any planned/large refactor (sequence the leaves/phases, with checkpoints); `Plan` for smaller sequences.

### 4. Isolate
**Skill:** `superpowers:using-git-worktrees` for anything sizable — keeps a long refactor off the working branch.

### 5. Execute in small behavior-preserving steps
**What:** Make the smallest structural change, **run tests, confirm green, commit** — then the next. Many tiny verified steps compose into the large transformation without ever leaving working code. **One hat per commit. Diffs small enough to actually review.**
**Skills:**
- `superpowers:subagent-driven-development` / `dispatching-parallel-agents` — fan out independent mechanical edits (renames, extractions across files).
- `code-simplifier` (agent) / `/simplify` — the mechanical-cleanup workhorses: reuse, simplification, efficiency, altitude on recently-changed code. **Quality only — they don't hunt bugs.** This is exactly where agents are strong (local, mechanical edits).
- `superpowers:systematic-debugging` when a step unexpectedly goes red — the suite just told you behavior moved; don't paper over it.
- `ralph-loop:ralph-loop` — **optional**, and only once the safety net is green (Phase 1): a passing characterization/approval suite *is* the automatic success criterion a Ralph loop needs. Run it with `--completion-promise` tied to the suite staying green and **always** `--max-iterations`. Subject to the hard rules below — one hat per commit, small reviewable diffs. Never for the design target (Phase 2).
- Domain/library skills as relevant — `vercel-composition-patterns` (untangling boolean-prop proliferation / into compound components), `vercel:react-best-practices`, `supabase-postgres-best-practices`, plus the CLAUDE.md skill-loading router for whatever area you're in.

### 6. Verify behavior preservation
**What:** The whole point — *prove* nothing observable changed, don't assert it. Run the full suite; diff outputs where you used characterization/approval tests; for visual code, compare the UI before/after in a real browser.
**Skills:** `superpowers:verification-before-completion`; `/verify` or `vercel:verification`; `/run`; `claude-in-chrome` for visual diffs.

### 7. Review & ship
**What:** Review, then integrate.
- `code-simplifier` / `/simplify` for a final quality pass; `/code-review` for correctness.
- `migration-guard` — **mandatory if the refactor touched `drizzle/` or schema** (timestamptz `USING`, `--name=`, destructive ops).
- `test-completeness` — if services/effects/`errors.ts` moved.
- `code-reviewer` — ADR adherence.
- `superpowers:requesting-`/`receiving-code-review`; `superpowers:finishing-a-development-branch`.
- Committing/pushing fires `security-guidance`'s agentic multi-file review automatically; clear or consciously dismiss any findings before the PR.
**Loop-back:** *if the refactor changed an architectural decision*, record it — an **ADR amendment** or new ADR (and update CLAUDE.md "Decisions made" if relevant). A refactor that crosses into a decision re-enters the decision process.

---

## Refactoring with AI agents — safely

This repo is largely built with AI agents, and the 2025 empirical record is specific: agents are **strong at mechanical, local edits** (rename, extract, retype, signature changes) and **weak at design-level deepening** (they rearrange far more than they reduce real complexity). Two failure modes dominate — make these hard rules:

1. **Lock behavior first.** Never let an agent refactor code without a safety net. Have it write characterization tests *before* restructuring, and **verify** preservation (run the suite, diff outputs) rather than trusting the agent's claim of equivalence — LLMs produce *plausible*, not *provably equivalent*, code.
2. **One hat per commit.** Agents routinely produce **tangled commits** (structure + behavior mixed) — the single biggest review hazard. Reject them; require pure refactor commits separate from any behavior change.
3. **Keep diffs small and reviewable.** If you can't review it, you can't trust it. Scope each agent refactor to one transformation.
4. **Humans/judgment own the design target** (Phase 2). Use agents to execute the *what*, not to decide it. Don't let speculative "future-proofing" abstractions in.

An autonomous loop (`ralph-loop`, Phase 5) doesn't bypass these rules — it *amplifies* the need for them: it's acceptable only with behavior locked first, pure one-hat commits, and small diffs, and never to decide the design target.

---

## Pitfalls

- **Big-bang rewrite** — long stretches with nothing shippable, divergence from the still-moving original. Prefer the incremental strategies (Phase 3).
- **No safety net** — characterize first or don't touch it.
- **Mixing hats / scope creep** — a "small cleanup" balloons or smuggles in behavior change. Time-box opportunistic cleanups; defer the rest; one hat per commit.
- **Speculative generality (YAGNI)** — abstractions for futures that never arrive; tell-tale smell: the only caller is a test. Refactor *toward today's* needs. (This ≠ Ousterhout's "invest strategically": design *today's* solution well and deep; don't build *tomorrow's* speculatively.)
- **Refactoring code you don't understand** — you'll "preserve" behavior you've actually broken. Characterize first; smaller steps.

---

## A noted tension (so we resolve it the same way each time)

Ousterhout is skeptical of strict TDD; Beck/Fowler treat tests as the indispensable safety net. We use **both, for different jobs**: **tests are the net that lets you refactor safely** (Phases 1, 5, 6); **APOSD judgment decides what to refactor *toward*** (Phase 2). They're complementary — never an excuse to skip the safety net.

---

## Current toolchain mapping

*Update this section when tooling changes; the phases above stay durable.*

| Phase | Primary | Also useful |
|---|---|---|
| 0. Confirm & size | `improve-codebase-architecture` | — |
| 1. Safety net | `superpowers:test-driven-development` | `feature-dev:code-explorer`; `Explore` |
| 2. Decide target | *(human/judgment — APOSD)* | `improve-codebase-architecture` |
| 3. Pick strategy | `superpowers:writing-plans` (large) | `Plan` |
| 4. Isolate | `superpowers:using-git-worktrees` | — |
| 5. Small steps | `code-simplifier` / `/simplify` | `subagent-driven-development`; `dispatching-parallel-agents`; `systematic-debugging`; `ralph-loop` *(safety-net-green only)*; `vercel-composition-patterns`; CLAUDE.md skill-loading table |
| 6. Verify preservation | `superpowers:verification-before-completion` | `/verify`; `vercel:verification`; `/run`; `claude-in-chrome` |
| 7. Review & ship | `code-reviewer`, `migration-guard`, `test-completeness` | `/simplify`; `/code-review`; `security-guidance` *(commit/push review)*; `requesting-`/`receiving-code-review`; `finishing-a-development-branch` |
