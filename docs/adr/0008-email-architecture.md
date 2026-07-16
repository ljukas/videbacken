# ADR 0008 — Email (Mailpit in dev, Resend in prod, React Email templates)

- **Status**: Accepted
- **Date**: 2026-05-26
- **Deciders**: Lukas
- **Decision in one line**: Send transactional email through a typed `src/lib/effects/email/` adapter with three implementations — `smtp` (nodemailer → Mailpit container in dev), `resend` (Resend SDK in prod), `devLog` (tests + offline). Templates are React components rendered server-side via `react-email`. Magic-link send stays tier-1 sync-critical; future non-auth emails (invitations, reminders, digests) are tier-3 via the queue.

> **Amendment (2026-06-10)** — The selector now requires **both** `RESEND_API_KEY` and `EMAIL_FROM` before picking the `resend` adapter (`src/lib/effects/email/email.ts`). Previously a half-configured Resend (key set, `EMAIL_FROM` forgotten) selected `resend` anyway, and the adapter threw on every send — magic-link is tier-1 sync-critical, so that bricked all sign-ins. Now the selector logs `logger.error('RESEND_API_KEY is set but EMAIL_FROM is missing; falling back to devLog')` and uses `devLog` instead (links surface in Runtime Logs, same as the pre-DNS deferred state). Precedence list and selector snippet below updated to match.

> **Amendment (2026-06-11)** — Sender domain verified; Resend is live in prod. Domain `mail.lukaslindqvist.se` (Resend region `eu-west-1`), DNS at Namecheap: MX + SPF TXT on `send.mail`, DKIM TXT on `resend._domainkey.mail`, DMARC on `_dmarc.mail`. `RESEND_API_KEY` + `EMAIL_FROM` (`Oceanview <no-reply@mail.lukaslindqvist.se>`) set in Vercel production env. With Resend active, magic-link URLs in Runtime Logs became a pure liability (see the closed "Interim risk" item under Deferred work), so the `devLog` adapter now redacts the URL when `NODE_ENV === 'production'` — a prod fall-through (config regression) still logs `magic-link (devLog)` as a misconfiguration signal, just without a usable sign-in link.

> **Amendment (2026-06-11, open tracking)** — Open tracking enabled on the Resend domain (`resend domains update <id> --open-tracking`). Resend injects a tracking pixel into the HTML part; opens are read in the Resend dashboard — no webhook, no app code. **Click tracking deliberately left off**: tracking is domain-wide (no per-email/per-link control in the Resend API), so enabling it would rewrite the one-time magic-link URL through Resend's redirect — an added failure mode on tier-1 sign-in, and a visible-URL/href mismatch on the template's plain fallback link (a spam-filter/phishing signal). Caveat: Apple Mail Privacy Protection pre-fetches pixels, so opens from Apple Mail users read as ~100% — the metric is directional, not exact.

> **Amendment (2026-06-24, second template — tier-3 realized)** — The first **non-auth** email shipped: user invitations. `EmailEffects` grew a second method, `sendUserInvited({ to, inviteUrl, locale })`, and the template `src/emails/InviteUserEmail.tsx` (+ `.test.tsx`) lands alongside `MagicLinkEmail.tsx` (sharing `theme.ts`). This is the realization of the "future non-auth emails go through the queue (tier-3)" note in § Execution tier choice: the invitation is **not** sent inline — Better Auth's `sendVerificationEmail` hook (`src/lib/auth.ts`) **enqueues** the new `email_user_invited` queue topic, and the worker (`src/lib/queue/handlers/emailUserInvited.ts`) calls `email.sendUserInvited(...)` through this same adapter seam. The `inviteUrl` is Better Auth's verify-email link (clicking it accepts the invite — verifies + auto-signs-in). The hook runs post-response via `waitUntil`, so it renders in `baseLocale` (`'sv'`) rather than a request-ALS locale. See [ADR-0007](./0007-background-job-queue-architecture.md) (topic + handler) and [ADR-0017](./0017-user-invitation-flow.md) (the invitation flow). The boundary discipline holds: only the adapters import `~/emails/InviteUserEmail`.

---

## Context

Email is the last unwired effect in the scaffold. `src/lib/effects/email/email.ts` exists with an `EmailEffects` interface, but the only adapter (`devLog`) logs to the structured logger — no SMTP, no Resend. `src/lib/auth.ts` already awaits `emailEffect.sendMagicLink({ to, url })`, so the call site is correct; only the implementation is missing.

We want a fully offline dev path that:

1. **Sends** real SMTP from the dev server to a local catcher, accepting any recipient address.
2. **Catches** every message in a web UI for inspection (HTML, plain-text, headers, raw).
3. Slots Resend in for production via the same adapter pattern without changing call sites.
4. Renders typed templates the same way in dev and prod (no "looks fine in Mailpit, broken in Gmail" surprises).

The architecture from ADR-0001 (typed effect seam, per-environment adapter) and ADR-0006 (three-way adapter split: prod / local-docker / devLog) already exists for storage and queue. Email is the third such seam.

---

## Decision (TL;DR)

**Use Mailpit + nodemailer in dev, Resend in prod, behind `src/lib/effects/email/`.**

Concretely:

- **Three adapters from day one**: `adapters/smtp.ts` (nodemailer), `adapters/resend.ts` (Resend SDK), `adapters/devLog.ts` (already present, unchanged).
- **Lazy selector** in `email.ts` mirrors `storage.ts` and `queue.ts` — dynamically imports the chosen adapter on first call so neither nodemailer nor the Resend SDK lands in the cold-start path of the other.
- **Adapter precedence** (highest → lowest):
  1. `VITEST === 'true'` → `devLog`. Tests never reach a real transport.
  2. `EMAIL_ADAPTER === 'devLog'` → `devLog`. Explicit offline override.
  3. `SMTP_HOST` set → `smtp`. Local dev (Mailpit) wins over Resend — protects against `vercel env pull` polluting `.env.local` with prod creds.
  4. `RESEND_API_KEY` **and** `EMAIL_FROM` set → `resend`. Production. Key without `EMAIL_FROM` logs an error and falls through to `devLog` instead of bricking sign-in (see Amendment 2026-06-10).
  5. Fallback → `devLog`. Offline dev without docker — auth flow still works; magic-links just appear in the log.
- **Mailpit** (`axllent/mailpit`) is the local catcher — `compose.yaml` service `mail`, SMTP on `:14522`, web UI on `:14502`. In-memory ring buffer (`MP_MAX_MESSAGES=500`); no persistent volume.
- **Templates** live in `src/emails/` (React Email convention; `react-email dev` previews them at `:14501`). Each template exports the React component and a typed `render<Name>(props): Promise<{ subject, html, text }>` helper. Adapters import the render helper, never the JSX.
- **First template** (`MagicLinkEmail.tsx`) is adapted from the official React Email demo's Studio brand pack (`apps/demo/emails/05-Studio/activation.tsx`, MIT — © 2024 Plus Five Five, Inc.). `theme.ts` (Tailwind config + neutral palette + font-scale plugin) and `Fonts.tsx` (Inter + Geist via `<Font>`) are copied verbatim with attribution; `MagicLinkEmail.tsx` is adapted (Swedish copy, no logo image, added URL-fallback block, reduced footer).
- **Subject lives in the render helper**, not the adapter — keeps localization next to the copy and lets every adapter stay dumb.
- **Magic-link send stays tier-1** (per ADR-0001 canonical example). See § Execution tier choice.

The seam from ADR-0001 means the choice is **reversible**: if Resend ever stops fitting (e.g. needs change to SES, Postmark, Mailgun), swapping is a file swap behind the existing interface — no procedures or call sites change.

---

## Architecture

### Adapter selector

```ts
// src/lib/effects/email/email.ts (adapter imports elided)
const getAdapter = lazy(async (): Promise<EmailEffects> => {
  if (process.env.VITEST === 'true') return devLog
  if (process.env.EMAIL_ADAPTER === 'devLog') return devLog
  if (process.env.SMTP_HOST) return smtp              // local wins over Resend
  if (process.env.RESEND_API_KEY) {
    if (process.env.EMAIL_FROM) return resend         // production
    // Half-configured Resend would throw on every send — and magic-link is
    // tier-1, so that bricks sign-in entirely. Complain loudly and fall back.
    logger.error('RESEND_API_KEY is set but EMAIL_FROM is missing; falling back to devLog')
    return devLog
  }
  return devLog
})
```

The cached `Promise<EmailEffects>` means the selector runs once per process. Lazy `await import('./adapters/<name>')` keeps nodemailer out of the Resend cold start and vice versa.

### Boundary discipline

- Only `adapters/smtp.ts` imports `nodemailer`.
- Only `adapters/resend.ts` imports `resend`.
- Only adapters import from `~/emails/*` — procedures and route handlers go through `email.sendMagicLink(...)`.

Verification greps (also in `## Verification`):

```bash
grep -rn "from 'nodemailer'" src/ | grep -v 'adapters/smtp.ts'    # must be empty
grep -rn "from 'resend'" src/    | grep -v 'adapters/resend.ts'   # must be empty
grep -rn "from '~/emails/" src/  | grep -v 'effects/email/adapters/'  # must be empty
# (no test-file exclusion needed: MagicLinkEmail.test.tsx imports './MagicLinkEmail'
# relatively, never via '~/emails/')
```

### Templates

`src/emails/` is flat for now:

```
src/emails/
  theme.ts                 # Studio Tailwind config + palette + font-scale (MIT)
  Fonts.tsx                # Inter + Geist via <Font> (MIT)
  MagicLinkEmail.tsx       # adapted from Studio activation.tsx (MIT)
  MagicLinkEmail.test.tsx  # asserts subject, URL in html+text, non-empty bodies
```

Conventions for future templates:

- One `<Name>Email.tsx` per email, exporting the React component + `render<Name>` async helper.
- Reuse `theme.ts` and `<TechFonts/>` from `Fonts.tsx`.
- Swedish copy, informal "du", brand "Oceanview" untranslated (per CLAUDE.md).
- When the second template lands, extract the duplicated hero-card shell into `src/emails/_layout/EmailShell.tsx` — premature on the first template.

### Execution tier choice

**Magic-link send stays tier-1 sync-critical** (per ADR-0001's canonical example). Rationale:

- User is staring at the login screen — direct feedback on failure beats "check your email" + silent failure.
- Magic links expire (~5 min). Queue lag is a real risk vs. a sync ~100–500ms send.
- Dev friction: requiring `pnpm dev:worker` for the basic happy path is a regression.
- A queue doesn't actually solve provider-outage — the job just stalls. Resend's own SDK retries transient errors internally.
- Industry norm: Clerk, WorkOS, Supabase, Better Auth's own examples all send auth mail synchronously.

**Future non-auth emails go through the queue (tier-3).** User-invitation, schedule-reminder, season-summary digest, ownership-change notice, etc. — none of these have a user waiting on the request. Pattern:

```ts
// procedure — topic joins the QueueTopic union in src/lib/effects/queue/queue.ts
// (snake_case, no namespacing — like 'blurhash' | 'image_thumbnail' | 'pdf_thumbnail')
await userService.invite(input)
await queue.publish('email_user_invited', { userId, invitedById })
// later: src/lib/queue/handlers/emailUserInvited.ts
import { email } from '~/lib/effects'
export async function handle(payload: EmailUserInvitedPayload) {
  await email.sendUserInvited(payload)  // same EmailEffects seam
}
```

The `EmailEffects` interface grows one method per kind; each adapter renders the corresponding template. Same seam, different invocation tier.

---

## Alternatives considered

### Local catcher

- **MailHog** — last release 2020-05, open security issues. Rejected.
- **MailCatcher** (`dockage/mailcatcher`, `schickling/mailcatcher`) — works fine but slow release cadence, no search, no REST API, larger Ruby image. Rejected for Mailpit's better feature set.
- **Mailtrap** — SaaS, requires internet + an account. Out of scope (offline-first).
- **EmailEngine** (https://emailengine.app/) — researched per question. Wrong layer: it's an IMAP/SMTP/Gmail-API → REST *gateway* for connected mailboxes, not a transactional sender or dev catcher. Proprietary ($995/year), needs Redis, doesn't replace either Mailpit or Resend. Skip.

### Sender

- **Self-hosted SMTP relay (Postfix)** — operationally heavy, deliverability is a fight (DKIM/DMARC/SPF/reverse-DNS/IP warmup). Rejected.
- **AWS SES** — cheaper at volume but the dashboard, templates, and React Email integration are worse. Free tier limited (62k mails/month only from EC2). Resend's free tier (3k/month, 100/day) more than covers 20 users.
- **Postmark, Mailgun, Sendgrid** — all viable; Resend wins on React Email integration, modern API, and current free-tier generosity.

### Template engine

- **React Email** — chosen. Resend-built, transport-agnostic, async `render(): Promise<string>` drops straight into the existing `Promise<void>` adapter contract. Active maintenance, 18k+ stars.
- **JSX Email** — same async-string API, smaller install, but smaller community. Migration cost is low if we ever swap.
- **MJML** — XML DSL, `mjml-react` poorly maintained. Loses on ergonomics + types.
- **Resend's hosted Templates feature** (https://resend.com/docs/dashboard/templates/introduction) — explicitly not used. Locks templates to Resend's dashboard, breaks dev/prod parity (Mailpit can't render them), no source control.
- **Plain HTML + handlebars** — fine for one template; hand-writing table-based HTML that survives Outlook/Gmail-mobile/dark-mode is painful by the third.

---

## Pricing

- **Mailpit** — free (Apache-2.0). Local container only.
- **Resend** — free tier (as of 2026-06-10): 100 emails/day, 3,000/month, 1 verified domain. Pro tier ($20/mo) lifts to 50k/month + extra domains. For ~20 users, free is forever.
- **Nodemailer** — free (MIT).
- **React Email** — free (MIT).

Net cost for the foreseeable future: **$0/mo**.

---

## Consequences

- **Wire-up**: ~3 new source files (`adapters/smtp.ts`, `adapters/resend.ts`, `emails/MagicLinkEmail.tsx`), 2 copied (`emails/theme.ts`, `emails/Fonts.tsx`), 1 restructured (`email.ts`).
- **`auth.ts` unchanged** — already calls `emailEffect.sendMagicLink({ to, url })`. The selector picks the right adapter from env.
- **Cold-start path**: only the chosen adapter is imported (lazy `import('./adapters/<name>')`).
- **Dev workflow**: `pnpm dev:up` brings Mailpit alongside db/queue/storage; login mail is visible at http://localhost:14502.
- **Deprecation note**: pnpm's deprecation warning on `@react-email/components@1.0.x` led us to use the `react-email` umbrella package directly. Modern recommended path.
- **Accepted enumeration oracle (2026-06-10 security audit)**: the magic-link request for an unknown, non-allowlisted email answers explicitly "Inget konto finns för denna e-postadress" (`src/lib/auth.ts`, `sendMagicLink` gate) instead of a uniform "if the address exists we've sent a link". A probe can therefore learn whether an email has an account. Deliberate: a co-owner who typos their address gets actionable feedback, membership of a ~15-person boat club is not a secret worth that UX cost, and the 5/min DB-backed rate limit bounds probing. Revisit if the app ever serves a userbase whose membership is sensitive.

---

## Revisit triggers

Re-open this decision if any of the following land:

- **Sender reputation issues** — bounces/complaints push us off Resend's free tier or shared IPs. Trigger: dedicated-IP need → SES or Postmark.
- **Multi-region delivery latency** — Resend's region affinity becomes a bottleneck. Unlikely at our scale.
- **Template authoring by non-engineers** — if non-engineers need to edit copy without a PR, the hosted Templates trade-off may flip. Today the audience is the engineer, so source-controlled wins.
- **Inbound email** — reply-to-thread or shared-inbox webhooks. Resend has these now; EmailEngine is the heavier alternative if multi-provider mailbox watching is ever needed (see Alternatives).

---

## Deferred work

- ~~**Sender-domain verification**~~ — **Done 2026-06-11** (see Amendment above): `mail.lukaslindqvist.se` verified, Vercel envs set, `resend` adapter active in prod.
- ~~**Interim risk: prod magic-links in Runtime Logs.**~~ — **Closed 2026-06-11**: the `devLog` adapter redacts the magic-link URL when `NODE_ENV === 'production'`, so a future config regression can't leak sign-in links into Runtime Logs. `src/lib/logger/redact.ts` stays unchanged (a global `url` path would scrub far too much).
- **Additional templates** — added with new features. **User invitation landed 2026-06-24** (see Amendment above): `InviteUserEmail.tsx` + `sendUserInvited` on `EmailEffects`, delivered tier-3 via the `email_user_invited` queue topic. Still open: schedule reminder, season summary. Each new template is one `<Name>Email.tsx` + one new method on `EmailEffects` + per-adapter wiring.
- **Webhook / bounce handling, suppression list** — Resend-side; not needed at 20 users. (Open tracking enabled 2026-06-11 — see Amendment; click tracking deliberately off.)
- **Logo asset** — `MagicLinkEmail.tsx` currently uses a styled text wordmark. Swap to a hosted image (Vercel Blob's `oceanview-public` store, or a base64-inlined SVG) once a brand mark exists.

---

## Files

- `src/lib/effects/email/email.ts` — interface + lazy selector
- `src/lib/effects/email/index.ts` — barrel
- `src/lib/effects/email/adapters/devLog.ts` — log-only adapter (unchanged)
- `src/lib/effects/email/adapters/smtp.ts` — nodemailer transport
- `src/lib/effects/email/adapters/resend.ts` — Resend SDK
  - Both transports require `EMAIL_FROM`; `resend` guards it (selector + adapter), while `smtp` passes it unchecked to nodemailer — a missing value fails at send time.
- `src/lib/effects/email/email.test.ts` — interface contract under the VITEST short-circuit; cannot exercise the precedence rules (see § Verification)
- `src/emails/theme.ts` — Studio Tailwind config (MIT)
- `src/emails/Fonts.tsx` — Studio Inter + Geist loading (MIT)
- `src/emails/MagicLinkEmail.tsx` — magic-link template + `renderMagicLink` (adapted from Studio, MIT)
- `src/emails/MagicLinkEmail.test.tsx` — render-output assertions
- `compose.yaml` — `mail` service (`axllent/mailpit:latest`)
- `package.json` — `mail:up` / `mail:down` / `email:dev` scripts; `mail` added to `dev:up`
- `.env.example` — `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM`, `RESEND_API_KEY`, optional `EMAIL_ADAPTER`

---

## Verification

End-to-end manual:

1. `pnpm dev:up` — Mailpit container healthy alongside db/queue/storage; `pnpm db:migrate` runs.
2. `open http://localhost:14502` — Mailpit web UI loads, inbox empty.
3. `pnpm dev` (separate terminal) — Vite on :14500.
4. Open http://localhost:14500/login, enter an allowlisted email, request a magic link.
5. Mailpit inbox shows one message. HTML tab renders the Swedish template; URL fallback appears below the button; headers show `From: Oceanview <no-reply@oceanview.local>`.
6. Click the button → signed in.
7. Server logs show `magic-link sent (smtp)` (not the devLog form).

Adapter selection (manual — this checklist *is* the precedence verification; the unit test can't cover it, see Tests below):

- `unset SMTP_HOST; pnpm dev` → logs `magic-link (devLog)` (offline fallback).
- `SMTP_HOST=localhost RESEND_API_KEY=re_xxx pnpm dev` → still `smtp` (local wins).
- `EMAIL_ADAPTER=devLog SMTP_HOST=localhost pnpm dev` → `devLog` (override wins).

Tests: `pnpm test src/lib/effects/email src/emails` — passes (VITEST short-circuit forces devLog; render tests are pure). Note `email.test.ts` cannot exercise the precedence rules: the VITEST short-circuit wins before any other branch, and `lazy()` caches the chosen adapter once per process, so no env permutation is reachable in-test. The adapter-selection checklist above is the actual precedence verification.

Lint / typecheck: `pnpm check && pnpm build`.

Boundary greps:

```bash
grep -rn "from 'nodemailer'" src/ | grep -v 'adapters/smtp.ts'    # must be empty
grep -rn "from 'resend'" src/    | grep -v 'adapters/resend.ts'   # must be empty
grep -rn "from '~/emails/" src/  | grep -v 'effects/email/adapters/'  # must be empty
# (no test-file exclusion needed: MagicLinkEmail.test.tsx imports './MagicLinkEmail'
# relatively, never via '~/emails/')
```
