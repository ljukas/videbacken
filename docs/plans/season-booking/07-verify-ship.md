# Plan 07 — Verify, review, document, ship

> Part of [season-booking](./README.md). Requires plans 01–06 committed. Steps use checkbox syntax for tracking.

**Goal:** Evidence-backed "done": full suite green, project review agents run, the ADR's browser verification checklist walked in a real browser, CLAUDE.md updated, PR opened.

---

### Task 1: full verification + reviews

- [ ] **Step 1: Full suite + static checks**

Run: `pnpm test && pnpm check:ci && pnpm build`
Expected: both Vitest projects green; Biome dry-run clean; build + `tsc --noEmit` pass.

- [ ] **Step 2: Review agents (feature-workflow Phase 5)**

- `code-reviewer` — the ADR-aware review over the full branch diff (`git diff main...HEAD`). Booking-specific things it should bless: services own all DB access; procedures are thin glue with code-only errors; realtime publish after success; optimistic mutations invalidate on settle; no `console.*`; i18n key-completeness.
- `test-completeness` — re-run if anything under `src/lib/services/booking/` changed since plan 03's checkpoint.
- `migration-guard` — re-run only if `drizzle/` or `src/lib/db/schema/` changed since plan 01.
- The `security-guidance` plugin reviews at commit/push automatically. The booking surface worth a conscious look: every admin mutation is behind `adminProcedure` (never inline role checks), and wish mutations derive the actor from the session (`context.user.id`), never from input. If anything looks off, run `/security-review`.

Address findings or dismiss them with explicit reasons (superpowers:receiving-code-review).

- [ ] **Step 3: Live browser pass (feature-workflow Phase 6; ADR-0020 §Verification)**

With `pnpm dev` (+ `pnpm dev:worker` not needed — no queue topics here) and a signed-in session, walk in a real browser (claude-in-chrome):

**Owner flow (open round):**
1. `/` shows `Bokning <year>` above the Disponeringslista, `● Öppen för önskemål` chip, 24-week strip (dashed extras 19–20/41–42 around the ten pastel blocks).
2. Click another share's block → wish chip paints instantly (optimistic); click again → unmarks. The acting share's own block is disabled.
3. Second browser tab (second signed-in session if possible): wish badges live-update via `booking.changed`.
4. Owner with several shares: `Önskar som: A · B` selector switches the acting share; single-share owner sees no selector; a share-less user gets a view-only strip.
5. Extra blocks toggle marks the same way.

**Admin flow:**
6. `Ordna` → suggestion panel shows `Förslaget uppfyller X av Y bytesönskemål` + pills (`A ↔ D`, 3-cycles, `19–20 → D`); `Använd förslaget` repaints the strip; `Utkast — endast synligt för admins` chip appears. Verify a non-admin session still sees the *nominal* strip.
7. Select-then-act: click a rotation block (brand ring + bar hint), click another → holders swap; Esc deselects.
8. Click an extra / unassigned block → popover with interested shares first, all shares, `Töm` (extras only).
9. `Återställ` re-seeds nominal. `Lås säsong` → confirm dialog → everyone (both tabs) sees the final schedule; owner summary line `Dina veckor {year}: …` correct; wish chips gone.
10. Locked chip → `Lås upp…` → confirm → round reopens, wishes reappear, draft preserved.

**Cross-cutting:**
11. Mobile (<lg, e.g. 390px): booking cards mirror the flows (tap = toggle; arrange + popover work).
12. Both themes; both locales (sv/en — check chip texts, aria-labels via inspector); `prefers-reduced-motion` (no transitions).

Fix what fails (superpowers:systematic-debugging — no guess-patching), re-run the suite, then continue.

---

### Task 2: CLAUDE.md updates

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Code map** — add to the `procedures/` list in the `orpc/` entry: `booking`; add `booking` to the services list (`user, season, share, booking, …`); add `booking/` to the components list.

- [ ] **Step 2: Skill-router table** — add the row:

```markdown
| Season booking, trade wishes, locking | `docs/adr/0020-season-booking-and-trades.md` |
```

- [ ] **Step 3: "Decisions made" bullet** — append:

```markdown
- **Season booking per ADR-0020** (2026-07-06). A per-season booking round above the nominal Disponeringslista ("convention below, reality above"): consent-based trade wishes + extra-period marks per share (`season_wish`), a pure max-coverage cycle-solver suggestion, a persisted admin-only 12-slot draft with concrete weeks (`season_slot`, ADR-0019's revisit trigger consumed), reversible lock (`season_booking.locked_at`) publishing the final schedule. Active round = next season, flipping at ISO week 43; year always server-derived. `booking.changed` realtime kind; code-only `BookingDomainError` codes mapped in `bookingErrorMessage.ts`. See ADR-0020.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit --no-gpg-sign -m "docs: register season booking in CLAUDE.md"
```

---

### Task 3: ship

- [ ] **Step 1: Branch hygiene**

Check whether the `feat/whole-share-calendar-cells` PR has squash-merged into `main`. If yes, this branch must be rebased onto `main` so the PR diff contains only booking work. **Ask the user before rebasing/force-pushing** (their standing rule — no destructive git without confirmation).

- [ ] **Step 2: Open the PR**

Use superpowers:finishing-a-development-branch. Squash-merge conventions:

- **Title** (= squash commit subject): `feat(booking): season booking with trade wishes and locking`
- **Body** (= squash commit body): the *why* — off-app season negotiation had no record; consent-based wishes + admin-arranged draft + reversible lock per ADR-0020; note the slot model consumes ADR-0019's "store concrete weeks" trigger; link `docs/adr/0020-season-booking-and-trades.md` and `docs/plans/season-booking/`.
- One concern per PR: this branch is only booking (+ the two small season refactors it required: `monthBandsForRange`, shared calendar constants — mention them in the body).

- [ ] **Step 3: Post-merge follow-ups (note in the PR body)**

- Email at lock, wish deadlines, historical locked seasons in the Disponeringslista, dnd-kit arranging: all deliberate non-goals with revisit triggers in ADR-0020.
