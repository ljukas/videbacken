# ADR 0017 — User Invitation Flow

- **Status**: Accepted
- **Date**: 2026-06-24
- **Deciders**: Lukas
- **Decision in one line**: Inviting a user **is** Better Auth's email-verification flow — an admin enters only an email, a `user` row is created unverified, and Better Auth's `sendVerificationEmail` hook (decoupled 7-day link, `autoSignInAfterVerification`) delivers a verify-email link whose click verifies *and* signs the invitee in. "Invited/pending" is **derived** from `emailVerified === false`; the only new stored state is one nullable `lastInvitedAt` column driving the owners-list countdown. No custom accept route, no invitation-token table.

---

## Context

The scaffold's admin "add user" was a **cold insert**: a `user` row created with `emailVerified: false` and **no email sent**. The invitee had no way in — an admin had to tell them out-of-band to go request a magic link. Two problems:

1. **No notification.** Adding a user did nothing the user could see. Onboarding lived entirely in a side channel ("hey, go to oceanview and sign in").
2. **The admin typed everything.** Name, phone, and role were entered by the admin at add-time — guesses the new owner would correct later anyway.

We want an **invitation**: the admin supplies an email, the system emails the invitee a link, and clicking it lands them signed-in. The link must survive **days** (an owner may not check email immediately), and accepting it should require zero extra screens.

Better Auth already owns sessions, magic-link login, and an email-verification flow. The question this ADR answers is *which Better Auth primitive carries the invite* — and the answer turns out to require almost no new state, because "verified" already means "this human has proven they control the address," which is exactly "accepted."

---

## Decision (TL;DR)

**An invitation is a Better Auth email-verification, sent on behalf of a freshly-created unverified user.**

Concretely:

- **Invite by email only.** `user.invite({ email })` (adminProcedure) creates the row via `userService.inviteUser(email)`: `name = email` (a sensible display placeholder, overwritten by the future onboarding flow), `phone = ''`, `role = 'user'` (every invitee is a Sailor — admins change role afterward via the existing Edit dialog), `emailVerified = false`, `lastInvitedAt = now`.
- **Mechanism = Better Auth's built-in email-verification.** `src/lib/auth.ts` configures `emailVerification: { expiresIn: INVITE_EXPIRY_SECONDS, autoSignInAfterVerification: true, sendVerificationEmail }`. The verify-email link is a stateless JWT (no token row). Clicking it verifies the email **and** auto-signs the invitee in (Better Auth's `internalAdapter.createSession` + `setSessionCookie`), then redirects to `callbackURL` (`'/'`). **There is no custom accept route** — Better Auth's own `/api/auth/verify-email` endpoint is the accept endpoint.
- **"Invited/pending" is derived, not stored.** A user is pending **iff** `emailVerified === false`. Accept = first successful sign-in. Both the invite verify-link **and** an ordinary magic-link login set `emailVerified = true`, so the two accept paths converge with zero extra state — there is no separate "accepted" flag to keep in sync.
- **One new stored column: `lastInvitedAt timestamptz` (nullable)** on `user` (added as a Better Auth `additionalField`, regenerated via `pnpm auth:schema`, migration `drizzle/0013_add_user_last_invited_at.sql`). It exists **only** to drive the countdown: `inviteExpiresAt = lastInvitedAt + INVITE_EXPIRY_SECONDS` is computed server-side in the user list procedures (`withInviteExpiry`); the relative "går ut om …" / "Utgången" string is rendered client-side. `INVITE_EXPIRY_SECONDS` (= 7 days) is exported from the user service and is the **single source of truth** for the duration, shared by `auth.ts` (`expiresIn`) and the countdown, so the displayed expiry tracks the token's real lifetime up to the sub-second gap between stamping `lastInvitedAt` and Better Auth minting the token (the token is minted synchronously when `sendVerificationEmail` is called, not in the background worker). Null for self-signed-up users.
- **Email delivery is tier-3 (queued).** The `sendVerificationEmail` hook **enqueues** the new queue topic `email_user_invited` (`{ to, inviteUrl, locale }`, see ADR-0007); the worker (`src/lib/queue/handlers/emailUserInvited.ts`) renders `src/emails/InviteUserEmail.tsx` and sends through the existing email effect (`email.sendUserInvited`, see ADR-0008). Invite emails render in `baseLocale` (`'sv'`) because the hook runs post-response via `waitUntil` (no request ALS to read a locale from); recipients switch locale after signing in.
- **Resend.** `user.resendInvite({ id })` re-triggers `sendVerificationEmail` and bumps `lastInvitedAt` (resetting the countdown) — but only after the send trigger succeeds, so a rate-limited resend doesn't silently reset the clock.

The seam is shallow by design: we wired an invitation onto a primitive Better Auth already maintains, rather than building a parallel one.

---

## Alternatives considered

### A. Magic-link-in-email as the invite
- ➕ Reuses the login path verbatim; no new auth surface.
- ➖ Magic-link expiry is **global, 5 minutes**. An invitation may sit unread for days. Lengthening it would weaken every login link, since the two share one TTL.
- **Verdict**: no — the TTL coupling is fatal.

### B. Email OTP plugin
- ➕ Independent `expiresIn`, and `signInEmailOTP` creates a session — would technically work.
- ➖ Adds a whole extra auth plugin and its public endpoints to reason about and rate-limit, for **no benefit** over the core email-verification flow, which already gives us an independent TTL and session creation on click.
- **Verdict**: no — extra surface, no payback.

### C. Custom invitation-token table + `/invite/$token` accept route
- ➕ Full control over token shape, copy, and the accept page.
- ➖ Accepting would have to **mint a session ourselves**: either reach into Better Auth internals (`internalAdapter.createSession` + `setSessionCookie`) by hand, or use `impersonateUser` — whose semantics are wrong (1-hour cap, requires an admin session, can't impersonate admins). Plus a new table, a new route, token issuance/expiry/cleanup, all duplicating what email-verification already does.
- **Verdict**: no — the email-verification flow gives session creation **for free** on the verify click; a custom token would re-implement it badly.

---

## Architecture

### Service ops — `src/lib/services/user/user.ts`

Three new exports, alongside the existing guarded operations (ADR-0002):

- **`inviteUser(email): Promise<UserRow>`** — check-first on the email (`findIdByEmail` → `UserDomainError('EMAIL_TAKEN')`; the unique constraint is the silent backstop, per ADR-0002's "Check first"), then insert the unverified, `lastInvitedAt`-stamped row.
- **`markInvited(targetId): Promise<void>`** — bump `lastInvitedAt` so the countdown resets (resend path).
- **`assertInviteResendable(targetId): Promise<UserRow>`** — guard a resend: `findActiveById` (null for unknown *and* soft-deleted → `NOT_FOUND`), then reject an already-verified user with `ALREADY_ACCEPTED`.

`INVITE_EXPIRY_SECONDS` is exported from the same module.

### Domain error codes — `src/lib/services/user/errors.ts`

Two codes join the `UserDomainErrorCode` union (code-only; the client localizes, per ADR-0002's 2026-06-14 amendment):

- **`ALREADY_ACCEPTED`** — resend attempted on a user who has already completed sign-in (`emailVerified`).
- **`EMAIL_TAKEN`** — invite attempted for an email already belonging to a user (active or soft-deleted) — the admin should resend or restore instead.

Both surface as oRPC typed errors via `userErrors` in `src/lib/orpc/procedures/user.ts` (`satisfies Record<UserDomainErrorCode, …>` locks the keys) and localize through `src/lib/orpc/userErrorMessage.ts`.

### Procedures — `src/lib/orpc/procedures/user.ts`

`create` was reshaped into **`invite`** (email-only input) and a new **`resendInvite`**.

```ts
// invite — adminProcedure, after the service insert succeeds:
await auth.api.sendVerificationEmail({ body: { email: created.email, callbackURL: '/' } })
```

The send-trigger is wrapped in a `try/catch` that only `context.log.warn`s on failure: the row already exists, so a transient queue-trigger failure must not fail the invite — the admin can resend. `resendInvite` is the opposite: it lets a send failure (e.g. rate limit) propagate so the admin gets feedback, and stamps `lastInvitedAt` only **after** the trigger succeeds.

Both publish `user.changed` (ADR-0004). The `list` / `listContacts` procedures map rows through `withInviteExpiry` to attach the computed `inviteExpiresAt`.

### `auth.ts` configuration

`emailVerification.sendVerificationEmail` enqueues `email_user_invited` with `locale: baseLocale` (the hook runs post-response via `waitUntil`, so there is no request ALS locale to read). `expiresIn` is set to `userService.INVITE_EXPIRY_SECONDS`, and `autoSignInAfterVerification: true` is what turns "verify" into "accept + signed in."

### UI

- `src/components/user/InviteUserDialog.tsx` — email-only `ResponsiveDialog`. **Pessimistic close** (per ADR-0013): `EMAIL_TAKEN` is user-fixable, so the dialog resets + closes only on success and stays open with an inline toast on failure.
- `src/components/user/OwnersTable.tsx` — renders an "Inbjuden" badge + an `InviteCountdown` (derived from `inviteExpiresAt`) for pending rows (`!owner.emailVerified`), plus a "Skicka inbjudan igen" resend action.
- **Pending users are admin-only.** `user.listContacts` (the active owners list, a `protectedProcedure` called by everyone) filters out pending rows (`emailVerified === false`) for non-admins, so a regular owner's client never receives a half-onboarded invitee's data. Filtering lives at the procedure boundary (`context.user.role`), not the service — `userService.listAll()` stays role-agnostic. The admin-only `list` procedure is unaffected. A logged-in non-admin is always verified (first sign-in flips it), so this never hides the current user from themselves.
- `UserFormFields` (name/phone/role) and `AvatarUpload` are **untouched** — reused by the Edit dialog and the future onboarding flow (see Deferred).

---

## Security notes

- **Call `sendVerificationEmail` without the admin's session headers.** With a session, Better Auth's `/send-verification-email` requires the email to match the **caller's own** (`EMAIL_MISMATCH`) — which an invite, by definition, never does. The **no-session** branch resolves the user by email and sends, and carries built-in **anti-enumeration**: unknown or already-verified emails silently no-op. Passing `context.headers` here would break every invite.
- **Rate limit.** A new custom rule `'/send-verification-email': { window: 60, max: 5 }` (mirroring the magic-link rule) blunts invite-email spam, since the no-session branch is publicly callable.

---

## Consequences

**Positive**:
- **Almost no new state.** One nullable column, derived status, no token table, no accept route. Deleting `lastInvitedAt` would only cost the countdown — the invite/accept flow itself rides entirely on Better Auth's existing verification.
- **Two accept paths converge.** Invite-link and ordinary magic-link login both flip `emailVerified`, so there is no second "accepted" flag to keep consistent.
- **Session creation for free** on the verify click — no internal-adapter wrangling.
- **Delivery is resilient.** Tier-3 queue means retry/backoff on the SMTP/Resend send, off the admin's request.

**Negative**:
- **Adding the topic touched five places** (the ADR-0007 tax): the `QueueTopic`/`QueuePayloadMap` union, the handler, the `vercel:queue` switch, the `vite.config.ts` trigger, and the dev worker.
- **The `EMAIL_MISMATCH` gotcha is non-obvious** — passing headers "to be safe" silently breaks invites. Captured above and in a code comment.
- **Invite emails are always Swedish** (`baseLocale`) — acceptable, since invitees are new and switch locale after signing in, but it means the invite copy can't honor a pre-existing preference (there is none to honor).

**Interaction with the last-admin guard (ADR-0009 Rule 3)**: the guard counts non-deleted admins **regardless of verification status** — a *pending* (unverified) admin still counts toward "at least one active admin." This is the correct conservative reading (a pending admin is a real admin who simply hasn't signed in yet), but note the nuance: an org whose only admin is still pending can't be left admin-less by a demotion, which is intended.

**Follow-up (now implemented)**: a dedicated **onboarding flow** for accepted invitees to collect their real name, optional phone, and a profile-picture upload — replacing the `name = email` placeholder. See the **2026-06-24 amendment — onboarding flow** below.

---

## Files

- `src/lib/auth.ts` — `emailVerification` config (`expiresIn`, `autoSignInAfterVerification`, `sendVerificationEmail` enqueue); `lastInvitedAt` `additionalField`; `/send-verification-email` rate-limit rule.
- `src/lib/services/user/user.ts` — `inviteUser`, `markInvited`, `assertInviteResendable`, `INVITE_EXPIRY_SECONDS`.
- `src/lib/services/user/errors.ts` — `ALREADY_ACCEPTED`, `EMAIL_TAKEN` codes.
- `src/lib/orpc/procedures/user.ts` — `invite`, `resendInvite`, `withInviteExpiry`, `userErrors`.
- `src/lib/orpc/userErrorMessage.ts` — client localization of the two new codes.
- `src/lib/effects/email/email.ts` — `sendUserInvited` on `EmailEffects` (see ADR-0008).
- `src/lib/effects/queue/queue.ts` — `email_user_invited` topic + payload (see ADR-0007).
- `src/lib/queue/handlers/emailUserInvited.ts` — the shared handler.
- `server/plugins/queueConsumer.ts`, `scripts/devQueueWorker.ts`, `vite.config.ts` — topic wiring (prod hook, dev worker, trigger).
- `src/emails/InviteUserEmail.tsx` (+ `.test.tsx`) — the invitation template.
- `src/components/user/InviteUserDialog.tsx`, `src/components/user/OwnersTable.tsx` — invite UI + countdown + resend.
- `drizzle/0013_add_user_last_invited_at.sql` — the one new column.

---

## Verification

- Admin opens "Bjud in", enters a new email → row created unverified, "Inbjuden" badge + countdown appear immediately; an invite email lands in Mailpit (dev) / the inbox (prod).
- Click the verify link → invitee lands signed-in at `/`; `emailVerified` flips true; the badge/countdown disappears on the next list refetch.
- Invite an existing email → `EMAIL_TAKEN` toast, dialog stays open.
- Resend on an accepted user → `ALREADY_ACCEPTED`; resend on a pending user → countdown resets.
- A normal magic-link login (no invite) also flips `emailVerified` — confirm the two accept paths converge.
- `pnpm test src/lib/services/user/user.test.ts` exercises each new code.

## Revisit triggers

- **Better Auth changes `verify-email` semantics** (drops `autoSignInAfterVerification`, or stops setting `emailVerified` on magic-link login) — the derived-status convergence would break; revisit then.
- **Onboarding lands** — *done* (2026-06-24 amendment below): the `name = email` placeholder now gets a real collection step at first sign-in.
- **Invites need a non-Swedish locale** (an invitee whose preference is somehow known ahead of accept) — the `baseLocale` choice would need an explicit locale on the payload.

---

## 2026-06-24 amendment — email is immutable after invite

Email is the **sole magic-link login identity** (`sendMagicLink` resolves the user by email alone), so it must not be casually editable. An admin typo would silently and permanently lock the user out — the next sign-in looks up an address that no longer exists, with no notification and no re-verification flow (Better Auth's `changeEmail` is not wired).

**Decision: email is set once, at invite, and is immutable thereafter.**

- `email` is **removed from the admin update path** entirely — absent from `userInputSchema` (the `update` procedure's input), from `UpdateUserInput`, and from the `updateAsAdmin` `.set({…})`. Only `name`, `phone`, and `role` are editable.
- `EditUserDialog` shows the email **read-only** (disabled field + `user_field_email_locked_hint`) for context; the editable group (`UserFormFields`) no longer renders an email input.
- To change an address: **delete + re-invite**. Clean for pending invitees (no session/data); acceptable at this 10–20-user scale.
- Side effect: this also closes a latent gap — `updateAsAdmin` never had the check-first uniqueness guard `inviteUser` has, so a duplicate email previously surfaced as a raw Postgres 23505 → 500 instead of a typed `EMAIL_TAKEN`. With email out of the update path the gap is gone (`EMAIL_TAKEN` stays used by `inviteUser` only).

**Revisit trigger:** if a genuine in-place email-change need appears, wire Better Auth's `changeEmail` with re-verification to the new address (and a check-first `EMAIL_TAKEN`) rather than reopening the free-text field.

---

## 2026-06-24 amendment — onboarding flow (implemented)

The deferred onboarding flow is now built. After accepting (the verify-email click auto-signs them in, or any first magic-link login), an invitee is taken through a **3-screen, one-input-per-screen wizard** before reaching the app: **name** (required), **phone** (skippable), **avatar** (skippable). It replaces the `name = email` placeholder with a real display name and lets owners add a phone (so others can reach them) and a picture.

**Visual shell.** A **top-level** route `src/routes/onboarding.tsx` — *not* under `_authenticated`, so it renders full-screen with no app shell, exactly like `/login`: the `brand-wash` background, the `Wordmark`, `size="xl"` floating-label inputs, the locale/theme toggles, and a 3-dot step indicator (active dot `bg-brand`). See ADR-0015.

**Forcing the wizard — and why the gate reads `me`, not the session.** The redirect lives in the **`_authenticated.tsx` loader**, which already fetches `orpc.user.me`. `me` deliberately bypasses the session cookie cache (`disableCookieCache: true`), so gating on `me.onboardedAt == null` reads *fresh* state. Gating on the cookie-cached `session.user` instead would loop for up to the 5-minute cache TTL: completion writes `onboardedAt` directly via the service, which the cached session wouldn't reflect, so the guard would bounce the just-finished user straight back. On completion the wizard `refetchQueries(orpc.user.me)` before navigating to `/`, so the loader sees the stamp immediately. The onboarding route's own loader does the inverse (`onboardedAt != null → redirect '/'`) so a finished user can't re-enter it.

**New stored state: `onboardedAt timestamptz` (nullable)** on `user` — a Better Auth `additionalField` (`input: false`, written only by the service; regenerated via `pnpm auth:schema`), migration `drizzle/0014_add_user_onboarded_at.sql`. The migration **backfills** existing verified users (`UPDATE … WHERE email_verified = true`) so current owners aren't routed into the wizard; pending invitees stay `NULL` and onboard on first sign-in.

We chose an explicit column over deriving "needs onboarding" from the `name === email` placeholder: the placeholder heuristic is coupled to a mutable display value (an admin editing a name would silently "onboard" that user), whereas a dedicated timestamp is unambiguous and decoupled.

**Completion model.** `onboardedAt` means "finished/skipped the *whole* wizard" — stamped **only at the final step**, so a mid-flow refresh keeps the user in the wizard (the route loader sees `onboardedAt == null`). Name/phone are **saved per step** (so `?step=phone` survives a refresh, re-prefilling from `me`); the avatar persists on upload via the existing `AvatarUpload` (mint→upload→confirm). Because `useRealtimeSync` isn't mounted outside the authenticated shell, the name step invalidates `me` itself so later steps (avatar initials) reflect the new name.

**Service ops — `src/lib/services/user/user.ts`**:
- **`updateOwnProfile(userId, { name?, phone? })`** — self-update (the procedure scopes `userId` to the caller). Check-first `NOT_FOUND` / `TARGET_DELETED`; writes only the provided fields; **never** `role` or `email`.
- **`completeOnboarding(userId)`** — stamps `onboardedAt = now()` (idempotent).

No new error codes — both reuse `NOT_FOUND` / `TARGET_DELETED`.

**Procedures — `src/lib/orpc/procedures/user.ts`** (both `protectedProcedure`, self-scoped on `context.user.id`, never an input id, so no admin gate):
- **`updateProfile`** — input `{ name?, phone? }` (same name/phone validators as the admin schema, both optional); publishes `user.changed` (name/phone show in the contact list).
- **`completeOnboarding`** — no input.

**Files**:
- `src/lib/auth.ts` — `onboardedAt` `additionalField`.
- `src/routes/onboarding.tsx` — full-screen guarded route, `?step=name|phone|avatar`.
- `src/components/onboarding/{OnboardingWizard,OnboardingNameStep,OnboardingPhoneStep,OnboardingAvatarStep}.tsx`.
- `src/routes/_authenticated.tsx` — loader gate on `me.onboardedAt`.
- `src/lib/services/user/user.ts` (+ `user.test.ts`) — `updateOwnProfile`, `completeOnboarding`, `onboardedAt` in `UserRow`/selection.
- `src/lib/orpc/procedures/user.ts` — `updateProfile`, `completeOnboarding`.
- `messages/{sv,en}.json` — `onboarding_*` keys.
- `drizzle/0014_add_user_onboarded_at.sql` — column + backfill.

**Deferred (still out of scope):** none for the basic flow. A future account-page self-edit of name/phone can reuse `updateProfile`.
