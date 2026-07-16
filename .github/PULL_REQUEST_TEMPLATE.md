<!--
PR title = the squash-merge commit subject. Use Conventional Commits:
  <type>(<scope>): <subject>   (≤72 chars, imperative, lowercase subject)
  e.g.  feat(document): add bulk move dialog
GitHub appends (#NN) automatically on merge — don't type it.
See CLAUDE.md → Non-negotiables (Conventional Commits / squash-merge).

Keep this body short. Explain WHY and link the ADR; let the diff show the WHAT —
don't narrate every file. (Agent-written PRs especially: trim the verbosity.)
These HTML comments don't render — fill in or delete each section.
-->

## Why

<!-- Motivation in 1–3 sentences. Link the ADR/issue this implements or amends. -->

## What changed

<!-- Only if the title + diff don't make it obvious. Bullets, not prose. -->

## Verification

<!-- Evidence "done" is real — paste command output or describe the manual check. -->

- [ ] `pnpm check` clean
- [ ] `pnpm build` passes (tsc + bundle)
- [ ] `pnpm test` passes — or _N/A (docs/config only)_
- [ ] Responsive on desktop + mobile — _if UI_

## Risks / follow-ups

<!-- Anything deferred, risky, or worth a closer look. Delete if none. -->
