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

**Seeding (amended 2026-10-17, server-latency row 9):** `INITIAL_ADMIN_EMAILS`
(CSV) is seeded as admin `approved_email` rows by the `seedApprovedEmails`
function in `src/lib/seedApprovedEmails.ts`, **once per deploy**:
`bun run db:seed` (`scripts/seedApprovedEmails.ts`) runs in `vercel-build` right
after `drizzle-kit migrate`, against the same database, and in `dev:up` after the
local migrations. The seed is idempotent: an email that is already approved keeps
its row and role. A failure exits 1 and fails the deploy, like a failed migration.
The table is the runtime source of truth thereafter; editing the env later does
not change existing rows, but a seed email whose row an admin removed gets an
admin row again on the next deploy (it did on every new instance before), so
remove it from the env as well.

*Before the amendment* a Nitro plugin (`server/plugins/seedApprovedEmails.ts`)
ran the seed on each instance's first request, under `waitUntil` (an init-time
seed's connect had timed out when Vercel suspended the instance). Nitro bundles
its plugins apart from the app, so the plugin's import gave every instance a
second copy of `~/lib/db` and a second pool, and each new instance spent a
connection on the seed's queries. Once per deploy is enough: the allowlist only
needs the first admin before anyone signs in.

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
- Bootstrapping depends on `vercel-build` running `bun run db:seed` after the
  migrations; that is a non-negotiable (see CLAUDE.md).
