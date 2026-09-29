# How we refactor

The durable arc for **behavior-preserving structural change**: making code easier to understand and cheaper to change *without changing what it observably does*.

Companions: **[feature-workflow.md](./feature-workflow.md)** for adding capability, **[bugfix-workflow.md](./bugfix-workflow.md)** for fixing wrong behavior. All three are governed by one rule:

> **The prime directive — one hat at a time (Kent Beck's "Two Hats").**
> A refactor changes *internal structure only*; observable behavior stays identical and tests stay green throughout (Fowler). Adding a feature or fixing a bug is the *other* hat. **Never wear both in the same commit.** If your change alters behavior, it isn't a refactor: it belongs in the feature or bugfix workflow. Keep refactor commits pure so any diff is *all-structure* or *all-behavior*; that's what makes review and rollback tractable.

> **Run it:** `/refactor-workflow <target>` (`.claude/skills/refactor-workflow/`) loads this doc and starts at Phase 0. Edit the process here, not in the skill.

> **Where the tools are.** The phases say *what* and *why*. *Which* skill or agent to use lives in [Current toolchain mapping](#current-toolchain-mapping); update that table, not the prose, when tooling changes. The prose names only mandatory review gates.

---

## The shape in one line

**Confirm & size → Safety net → Decide the target → Pick a strategy → Isolate → Small steps → Verify preservation → Review & ship.** Tests first, evidence at the end.

---

## The phases

### 0. Confirm it's a refactor, and size it
**What:** Two checks. (1) *Behavior-preserving?* If you're adding capability or fixing a bug, stop: wrong doc. (2) *How big?*
- **Opportunistic** (the campsite rule, "leave it better than you found it"): a bounded cleanup in code you're already touching. This is the **default**; it needs no ceremony beyond the safety net and one-hat discipline.
- **Planned / large**: a structural change big or risky enough to need a named strategy (Phase 3) and usually a plan. The exception, not the rule. (Fowler: a team refactoring well "should hardly ever need to plan refactoring.")
- **Preparatory** (for an upcoming feature): its own PR, landed before the feature. Example: #23 extracted `runPulledSync` from the Zaptec sync so the elpris sync could reuse the lifecycle instead of copying it.

Discovery and scoping speak the house vocabulary (deep modules, the deletion test); see Phase 2.

### 1. Establish the safety net — *first*
**What:** You can only *assert* behavior was preserved if a trustworthy test suite says so. Before touching structure, get to green.
- Covered code → confirm the relevant tests are green and meaningful.
- **Untested code → write characterization tests first** (Feathers): feed inputs, capture whatever the code *actually* does today (bugs included: you're pinning *what is*, not *what should be*), assert future runs match. They protect you *and* build the understanding you need.

**Rule:** **no safety net → no refactor.** Refactoring code you can't verify is editing-and-hoping.

### 2. Decide what to refactor *toward*
**What:** A refactor needs a destination, and ours is the vocabulary the ADRs already use, from **John Ousterhout's *A Philosophy of Software Design***:
- **Deepen modules**: powerful functionality behind a *simple* interface; push complexity *down*, not sideways into more small classes. Example: #20 turned two diverging queue consumers into one typed dispatcher, so adding a topic went from 5 steps to 3 and an unhandled topic fails to compile.
- **Hide information**: each module hides a decision (format, algorithm, dependency). Target *information leakage*, where one decision is smeared across modules.
- **Reduce complexity** = reduce **dependencies** and **obscurity**, the two things that make change hard. "Does this lower net complexity?" is the acceptance test.
- **Define errors out of existence**: redesign an API so an edge case *can't arise* instead of making every caller handle it. A deepening move when the same error is handled at many call sites.
- **The deletion test** (house idiom): if you deleted this module, would complexity reconcentrate elsewhere? If not, it's *shallow* and shouldn't exist.

**Judgment — design is a human call.** This is the one phase AI agents are *weak* at (they rearrange more than they deepen). Decide the target with judgment; use agents for the mechanics (Phase 5).

### 3. Pick a strategy sized to the risk
**Small / local** → just take small steps (Phase 5). Catalog moves: Extract/Inline Function, Move, Rename, Replace Conditional with Polymorphism.

**Large / risky** → pick a named strategy so the codebase stays shippable throughout:

| Strategy | What it is | Use when |
|---|---|---|
| **Mikado Method** | Attempt the change; when it breaks, note the prerequisite, **revert**, recurse into a dependency graph; then execute leaves-first, each landing on green `main`. | Many tangled, *unknown* prerequisites; you want to avoid a branch that's broken for weeks. |
| **Strangler Fig** | Route through a facade, build the replacement behind it piece by piece, redirect gradually, delete the old once nothing routes to it. | Migrating a subsystem or **swapping a provider** behind an effect adapter (the `src/lib/effects/*` selectors are the facade). |
| **Branch by Abstraction** | Introduce an abstraction in front of the thing, migrate all callers to it, build the new impl behind it, flip the default, delete the old. | Replacing something **many call sites depend on**: a shared helper, an internal API, the data layer. |
| **Parallel Change** (expand → migrate → contract) | Add the new form alongside the old, move all callers/data over, then remove the old. | Changing a **widely-used interface, schema, or DB column** you can't update atomically. For DB, pairs with additive migrations. |

(*Mechanism note:* feature flags, or a parallel run that compares old-vs-new output, keep cutovers reversible.)

#### Replacing hand-rolled code with a library
A library swap is a refactor *only if behavior stays the same*, and libraries rarely match hand-rolled code exactly. Treat it as Branch by Abstraction around the old helper:
1. **Pin the current behavior** with characterization tests on the edge cases the hand-rolled code handles on purpose: timeouts, `Retry-After`, retrying a body that drops mid-download, DST boundaries, TTL expiry, in-flight de-duplication.
2. **List the semantic gaps** between the old code and the library by reading the library's *current* docs, not memory. Example: swapping the `send()` retry loops in `effects/zaptec/client.ts` / `effects/elpris/client.ts` for `ky`: does its timeout/retry also cover a response body that fails mid-read? The old loops read the body inside the attempt on purpose. (It doesn't by default: ky's timeout ends once headers arrive. The fix is to hand ky a `fetch` that reads the whole body before resolving, so a mid-body drop or stall is retried.)
3. **Rule on each gap:** configure or wrap the library so behavior is identical (stays a refactor), or change behavior deliberately (that's the *other* hat: a separate `fix`/`feat` commit, stated in the PR).
4. **Delete the old code and any dependency it leaves unused.** For client code, check the bundle-size cost.
5. **One PR per library**, so a regression bisects to one swap.

### 4. Isolate
**What:** A git worktree for anything sizable, keeping a long refactor off the working branch.

### 5. Execute in small behavior-preserving steps
**What:** Make the smallest structural change, **run tests, confirm green, commit**, then the next. Many tiny verified steps compose into the large transformation without ever leaving working code. **One hat per commit. Diffs small enough to actually review.**
- Fan out *independent mechanical* edits (renames, extractions across files); that's where agents are strong.
- A step that unexpectedly goes red means behavior moved. Debug it; don't paper over it.
- Planned/large refactors run the same **per-task adversarial review loop** as features ([feature-workflow.md → Phase 4](./feature-workflow.md#4-build-task-by-task)): after each step, two reviewers told to assume the step changed behavior.
- An autonomous loop is allowed **only** once the safety net is green (the passing suite *is* its success criterion), with a hard iteration cap, and never for the design target.

### 6. Verify behavior preservation
**What:** The whole point: *prove* nothing observable changed, don't assert it. Run the full suite and the [pre-PR gate](./feature-workflow.md#pre-pr-gate); diff outputs where you used characterization tests; for visual code, compare the UI before/after in a real browser.

### 7. Review & ship
**What:** Review the whole branch, then integrate.
- Always → `code-reviewer` (ADR adherence) and a general correctness pass, told to look for behavior that moved.
- Touched `drizzle/` or schema → `migration-guard` **and** the schema-design review (mandatory).
- Moved services / effects / `errors.ts` → `test-completeness`.
- Moved auth, session, file-access or `adminProcedure`/`protectedProcedure` gating → a dedicated security pass, told to check that no boundary moved.
- `security-guidance` reviews at commit/push; clear or consciously dismiss its findings before the PR.
- Open the PR with the template; `refactor(<scope>): …` title; squash-merge.

**Loop-back:** *if the refactor changed an architectural decision*, record it: an **ADR amendment** or a new ADR (#20 amended ADR-0007), and update CLAUDE.md "Decisions made" if relevant.

---

## Refactoring with AI agents — safely

This repo is largely built with AI agents, and the empirical record is specific: agents are **strong at mechanical, local edits** (rename, extract, retype, signature changes) and **weak at design-level deepening** (they rearrange far more than they reduce real complexity). Hard rules:

1. **Lock behavior first.** Never let an agent refactor without a safety net. Have it write characterization tests *before* restructuring, and **verify** preservation (run the suite, diff outputs) instead of trusting its claim of equivalence. LLMs produce *plausible*, not *provably equivalent*, code.
2. **One hat per commit.** Agents routinely produce **tangled commits** (structure + behavior mixed), the single biggest review hazard. Reject them.
3. **Keep diffs small and reviewable.** If you can't review it, you can't trust it. One transformation per agent task.
4. **Humans/judgment own the design target** (Phase 2). Agents execute the *what*; they don't decide it. No speculative "future-proofing" abstractions.

An autonomous loop doesn't bypass these rules; it *amplifies* the need for them.

---

## Pitfalls

- **Big-bang rewrite**: long stretches with nothing shippable, divergence from the still-moving original. Prefer the incremental strategies (Phase 3).
- **No safety net**: characterize first or don't touch it.
- **Mixing hats / scope creep**: a "small cleanup" balloons or smuggles in behavior change. Time-box opportunistic cleanups; defer the rest.
- **A library swap that quietly changes semantics**: retry, timeout and time-zone libraries all have opinions. List the gaps (Phase 3) before swapping.
- **Speculative generality (YAGNI)**: abstractions for futures that never arrive; tell-tale smell: the only caller is a test. Refactor *toward today's* needs. (This ≠ Ousterhout's "invest strategically": design *today's* solution well and deep; don't build *tomorrow's* speculatively.)
- **Refactoring code you don't understand**: you'll "preserve" behavior you've actually broken. Characterize first; smaller steps.

---

## A noted tension (so we resolve it the same way each time)

Ousterhout is skeptical of strict TDD; Beck/Fowler treat tests as the indispensable safety net. We use **both, for different jobs**: **tests are the net that lets you refactor safely** (Phases 1, 5, 6); **APOSD judgment decides what to refactor *toward*** (Phase 2). They're complementary, never an excuse to skip the safety net.

---

## Current toolchain mapping

*Where tools are listed (the prose names only mandatory gates). Entries tagged* (agent) *go through the `Agent` tool; the rest are skills. Update this section when tooling changes; the phases above stay durable.*

| Phase | Primary | Also useful |
|---|---|---|
| 0. Confirm & size | `improve-codebase-architecture` | — |
| 1. Safety net | `superpowers:test-driven-development` *(applied to characterization tests)* | `feature-dev:code-explorer` *(agent)*; `Explore` *(agent)* |
| 2. Decide target | *(human/judgment — APOSD)* | `improve-codebase-architecture` |
| 3. Pick strategy | `superpowers:writing-plans` *(planned/large)* | `Plan` *(agent)*; Context7 *(library docs for a swap's gap list)* |
| 4. Isolate | `superpowers:using-git-worktrees` | — |
| 5. Small steps | `code-simplifier:code-simplifier` *(agent)* / `/simplify` *(mechanical cleanup; quality only, no bug hunting)* | `superpowers:subagent-driven-development`; `superpowers:dispatching-parallel-agents`; `superpowers:systematic-debugging`; reviewers per [feature pairings](./feature-workflow.md#reviewer-pairings); `ralph-loop:ralph-loop` *(safety net green only; `--completion-promise DONE --max-iterations N`)*; `vercel-composition-patterns`; `vercel-react-best-practices`; `supabase-postgres-best-practices` |
| 6. Verify preservation | `superpowers:verification-before-completion` | `/run`; `claude-in-chrome` or the `playwright` plugin *(visual before/after)*; `vercel:verification` *(user-level plugin)* |
| 7. Review & ship | `code-reviewer`, `migration-guard`, `test-completeness` *(agents)*; schema-design reviewer *(`general-purpose` agent loading `supabase-postgres-best-practices`)* | `/simplify`; `/code-review` (`--fix` to apply); `/security-review`; `security-guidance` *(commit/push review)*; `superpowers:requesting-code-review` / `superpowers:receiving-code-review`; `superpowers:finishing-a-development-branch` |
