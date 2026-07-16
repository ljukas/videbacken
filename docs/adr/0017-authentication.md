# ADR-0017: Authentication — Google + magic-link, email allowlist, admin-only mutation

**Status:** Accepted
**Date:** 2026-07-16 (supersedes the original invitation-flow ADR)

## Context

Videbacken is an internal tool. Access must be restricted to an explicitly
approved set of people, sign-in must be low-friction, and the data model must
be simple to reason about. We use [Better Auth](https://www.better-auth.com)
(self-hosted) with the Drizzle adapter.

## Decision

### Two sign-in methods, both allowlist-gated

- **Google OAuth** (`socialProviders.google`) and **email magic-link**
  (`magicLink` plugin) are the only sign-in methods. Passwords and passkeys are
  not used.
- Both methods are gated by a single source of truth: the **`approved_email`**
  table (`src/lib/db/schema/approvedEmail.ts`). Only emails present in that
  table may create an account or sign in.
  - **Google:** `databaseHooks.user.create.before` (in `src/lib/auth.ts`) calls
    `resolveSignInDecision(email)`; if the email is not approved it throws an
    `APIError`, so no user row is ever created. This hook fires for any provider
    that creates a user, so a future provider can't bypass the gate silently.
  - **Magic-link:** `magicLink.sendMagicLink` checks `isApproved(email)` and
    refuses to send a link to a non-approved address.
- **No pre-created user rows.** The `user` row is created by Better Auth on the
  first successful sign-in via either method. The role is taken from the
  matching `approved_email` row.

### The allowlist (`approved_email`)

Columns: `id`, `email` (unique, normalized lowercase), `role`
(`'user' | 'admin'`, default `'user'`), `addedByUserId` (nullable),
`createdAt` (timestamptz). Owned by `src/lib/services/approvedEmail/`
(`isApproved`, `listApproved`, `addApproved`, `removeApproved`, `normalizeEmail`,
`resolveSignInDecision`).

**Seeding:** `INITIAL_ADMIN_EMAILS` (CSV) is seeded as admin `approved_email`
rows at server startup by the `seedApprovedEmails` function in
`src/lib/seedApprovedEmails.ts`, invoked from the Nitro plugin
`server/plugins/seedApprovedEmails.ts`, which is registered explicitly in
`vite.config.ts` (this project's Nitro does **not** auto-discover
`server/plugins/*` — plugins must be listed explicitly). The seed is idempotent
and fails soft (logs, never crashes). The table is the runtime source of truth
thereafter; editing the env later does not retroactively change existing rows.

### Roles and the authorization rule

Two roles: `user` and `admin` (Better Auth `admin` plugin).

**Global invariant — admins mutate, users are read-only:**
- **Reads** use `protectedProcedure` (any signed-in, approved user).
- **Every mutation** uses `adminProcedure`.
- **Sole exception — own account:** a `user` may manage only their own profile
  (`updateProfile`, `completeOnboarding`, own avatar upload), scoped to
  `context.user.id`. They cannot mutate any other/shared data.

### Invite / revoke (admin only)

- **Invite** (`user.invite`, admin): adds an `approved_email` row (chosen role,
  default `user`) — no user row — and enqueues a courtesy email
  (`email_user_invited` topic) whose CTA links to `/login` (Better Auth has no
  server API to mint a magic-link without firing its own send callback, so we
  point invitees at the login page where both methods are offered). Duplicate →
  `EMAIL_ALREADY_APPROVED`.
- **Resend invite** re-enqueues that courtesy email.
- **Revoke** (`user.revoke`, admin): removes the `approved_email` row,
  soft-deletes the matching `user` row (`deletedAt`), and revokes that user's
  sessions via `auth.api` so access is cut immediately. The `_authenticated`
  guard also bounces any session whose `user.deletedAt` is set.
- **Re-invite restores** a previously-revoked user: inviting an email that
  matches a soft-deleted `user` row clears its `deletedAt` and re-applies the
  invited role, so re-granted access actually works.
- `/users` lists active users **and** pending invites (`approved_email` rows
  with no matching user yet), tagged by status.

### Onboarding

First sign-in runs a 2-step wizard at `/onboarding` (**name → avatar**),
pre-filled from the Google profile. The `_authenticated` loader redirects while
`onboardedAt` is null; `completeOnboarding` stamps it. `phone` is an optional
field editable in account settings (not part of onboarding).

## Consequences

- Access control is centralized in one table + one gate, easy to audit.
- The admin-only-mutation rule keeps authorization trivial to reason about:
  a reviewer checks that every mutating procedure is `adminProcedure` except the
  two self-account ops.
- Bootstrapping depends on the seed plugin being registered; that registration
  is a non-negotiable (see CLAUDE.md).
