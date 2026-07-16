# Oceanview UI/UX Redesign — June 2026

Implementation plans for the "quiet nautical confidence" redesign. These are **execution plans**; the
*decisions* live in ADRs. Read the ADR for the why, the plan for the how.

> Status: **plans 01 (visual foundation) + 02 (login) implemented; plans 03–05 planned.** Each plan names the exact files to touch.

## Goal

Move the app from "bland" to a Linear/Family-inspired feel while staying a calm internal tool for ~10–20
sailboat co-owners. Boldness comes from a few concentrated moves on a restrained canvas, not pervasive
decoration.

## Shared decisions (locked)

- **Headings:** Cabinet Grotesk (self-hosted variable woff2 from Fontshare, ITF Free Font License). Retain
  the license file in-repo. Vintage-warm grotesque; full Thin–Black axis (no fixed-weight compromise).
- **Body/UI:** Switzer (self-hosted variable woff2 from Fontshare, ITF Free Font License). **Geist removed.**
  Body gets Linear-style tuning (tight tracking, optical sizing, tabular numerals in tables).
- **Brand accent:** one `--brand` token (≈ the nautical `#156cdd`), applied only to login/empty washes and the
  logo mark. `--primary` stays neutral.
- **Login:** split panel (branded left, login "window" right).
- Fallbacks documented in ADR-0015: Inter/Hanken body, Schibsted/Hanken heading — one-line token swaps.

## Plans

| # | Plan | ADR |
|---|---|---|
| 01 ✅ | [Visual foundation](./01-visual-foundation.md) — inset shell, `PageContainer`, typography, brand accent, dialog motion | [ADR-0015](../../adr/0015-visual-identity-and-design-language.md) |
| 02 ✅ | [Login redesign](./02-login-redesign.md) — centered branded page, card-less, `LogoMark` | ADR-0015 (applies) |
| 03 | [Data tables](./03-data-tables.md) — shared `RowActions` hover-reveal on both tables | — |
| 04 | [Command palette](./04-command-palette.md) — global Cmd+K | [ADR-0014](../../adr/0014-command-palette-architecture.md) |
| 05 | [Empty states](./05-empty-states.md) — `<Empty>` convention + role-gated CTAs | [ADR-0016](../../adr/0016-empty-state-and-feedback-conventions.md) |

## Sequencing

1. **01 visual foundation** — most other work consumes its `--brand` token + `PageContainer` + tokens.
2. **03 tables** + **05 empty states** — small, high value, depend only on the container/tokens.
3. **02 login** — consumes `--brand` + `Logo`.
4. **04 command palette** — largest; phased on its own.
5. **Dialog motion** (part of 01) — independent; can land anytime.

## Cross-cutting rules to honor

- Localize all user-facing strings via Paraglide `m.*()` (sv source of truth, en key-complete); run
  `pnpm i18n:compile` after editing `messages/*.json` outside `pnpm dev`.
- Every screen responsive (mobile/tablet/desktop); semantic color tokens only; `gap-*` not `space-y-*`;
  `size-*` for equal dimensions (`.claude/skills/shadcn`).
- Keyboard accessibility for any hover-revealed control (web-design-guidelines).
- Verify in light + dark, sv + en, mobile + desktop, and with `prefers-reduced-motion`.
