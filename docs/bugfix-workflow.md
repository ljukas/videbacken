# How we fix a bug

The durable arc for making **observed behavior match intended behavior**: find the real cause, pin it with a test, fix only that, and prove it's gone.

Companions — one hat per commit:
- **[feature-workflow.md](./feature-workflow.md)** — the "fix" actually needs new capability, or *intended* behavior was never decided.
- **[refactor-workflow.md](./refactor-workflow.md)** — the fix would be easy if the code were shaped differently. Refactor first, in its own commit or PR, then fix.

> **Run it:** `/bugfix-workflow <symptom>` (`.claude/skills/bugfix-workflow/`) loads this doc and starts at Phase 0. Edit the process here, not in the skill.

> **Where the tools are.** The phases say *what* and *why*. *Which* skill or agent to use lives only in [Current toolchain mapping](#current-toolchain-mapping).

---

## The shape in one line

**Confirm it's a bug → Reproduce → Find the root cause → Failing regression test → Minimal fix → Verify → Review & ship.** No fix without a cause; no cause without a repro.

---

## The phases

### 0. Confirm it's a bug, and gather evidence
**What:** A bug is behavior that contradicts something already decided: a spec, an ADR, a Non-negotiable, or plain correctness. If nobody decided what *should* happen, it's a product decision, so switch to the feature workflow.
**Evidence first, theories second.** Collect what actually happened before guessing why:
- **Prod:** Vercel runtime logs (`rpc timing` lines, `queue message` outcomes, error logs), the deploy that introduced it, `integration_sync` health rows for a sync, the browser log sink (`/api/log`).
- **Local:** the exact steps, input, locale, viewport and role (admin vs user).
- **Review findings** (e.g. #22 fixing #21's review): each finding is a bug report. Confirm it's real before fixing it.

### 1. Reproduce
**What:** Get the smallest reliable reproduction: a test, a script, or exact manual steps. Can't reproduce? Keep gathering evidence (Phase 0) rather than fixing blind. A fix for an unreproduced bug is a guess, and you can't show it worked.

### 2. Find the root cause
**What:** Trace from the symptom to the *first* place behavior goes wrong, not the place it becomes visible. Then ask two questions:
- **Where else does this pattern appear?** The same mistake usually lives in sibling code (the Zaptec and elpris clients, the per-source sync paths). Fix the class of bug, not the one instance, but in scope: list the other sites and fix them in the same PR only if they're the same cause.
- **Is this the second or third fix here?** Repeated fixes to one area mean the design is fighting you. The sensor-chart tooltip took four `fix` commits in a row, and the last one went back to Recharts' default animation. Stop and question the approach (often: stop hand-rolling what the library does) before adding another patch.

### 3. Write the failing regression test
**What:** A test that fails *for the right reason* (assert on the wrong behavior, not on a crash from test setup), before any fix.
- Service / pure logic / effect adapter → a node test next to the code.
- Component → a `*.browser.test.tsx` browser test.
- Truly visual (animation, layout at one viewport) → write down the manual repro steps in the PR and verify live in Phase 5. That's the only exception.

### 4. Make the minimal fix
**What:** Change only what the root cause requires. **One hat:** no drive-by refactors or cleanups in the fix commit. If the fix needs restructuring, land that as a separate `refactor` commit first, under the refactor workflow's safety-net rules.
The fix still honors the architectural rules and Non-negotiables (CLAUDE.md). A schema change still gets `migration-guard` **and** the schema-design review, even in a hurry. #24 (RLS) came out of exactly such a review.

### 5. Verify
**What:** The regression test now passes, the original repro no longer reproduces, and the [pre-PR gate](./feature-workflow.md#pre-pr-gate) is green. For visual bugs, check in a real browser at the viewport where it was reported, plus desktop/tablet/mobile.

### 6. Review & ship
**What:**
- `code-reviewer`, plus a reviewer told to assume the fix is incomplete: does it cover the sibling sites from Phase 2, and does the test actually fail without the fix?
- The project gates as they apply: `migration-guard` + schema-design review for schema, `test-completeness` for services/`errors.ts`.
- PR with the template: *Why* names the symptom and the root cause; `fix(<scope>): …` title; squash-merge. Group review-finding fixes by concern (as #22 did), not one PR per finding.

**Loop-back:** if the bug showed a *decision* was wrong, amend the ADR. #22 amended ADR-0019 and reversed its accepted "unpaired alert" trade-off. A missing guard that could recur project-wide belongs in CLAUDE.md or a review agent's checklist.

---

## Pitfalls

- **Fixing the symptom**: a `?? 0` or `try/catch` that hides the error instead of removing its cause. Missing data is not zero and a skipped sync is not a success: fail closed and surface it (ADR-0019).
- **No regression test**: the bug comes back in the next refactor.
- **Patch stacking**: the third fix in one area is a design problem, not a bug.
- **Scope creep**: "while I'm here" refactors in the fix commit make the fix unreviewable and unrevertable.
- **Trusting "fixed" without the repro**: rerun the original repro, not only the new test.

---

## Current toolchain mapping

*The only place tools are listed. Update this section when tooling changes; the phases above stay durable.*

| Phase | Primary | Also useful |
|---|---|---|
| 0. Evidence | Vercel runtime logs (`vercel logs` / the Vercel MCP `get_runtime_logs`) | `vercel:vercel-cli`; `claude-in-chrome` (console + network) |
| 1. Reproduce | `superpowers:systematic-debugging` | `/run`; `claude-in-chrome` or the `playwright` plugin |
| 2. Root cause | `superpowers:systematic-debugging` | `feature-dev:code-explorer`; `Explore`; Context7 *(check a library's actual behavior)* |
| 3. Regression test | `superpowers:test-driven-development` | — |
| 4. Minimal fix | — | `refactor-workflow` *(if restructuring is needed first)*; domain skills as in the [feature table](./feature-workflow.md#current-toolchain-mapping) |
| 5. Verify | `superpowers:verification-before-completion` | `claude-in-chrome` or the `playwright` plugin |
| 6. Review & ship | `code-reviewer`, plus `migration-guard` + schema-design reviewer / `test-completeness` as applicable | `/code-review`; `superpowers:receiving-code-review`; `superpowers:finishing-a-development-branch` |
