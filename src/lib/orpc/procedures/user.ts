import { z } from 'zod'
import { auth } from '~/lib/auth'
import { realtime } from '~/lib/effects'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import { inviteInputSchema } from '~/lib/orpc/userInviteSchema'
import { nameField, phoneField, selfProfileSchema } from '~/lib/orpc/userProfileSchema'
import * as shareService from '~/lib/services/share'
import * as userService from '~/lib/services/user'
import { UserDomainError, type UserDomainErrorCode } from '~/lib/services/user'
import type { ShareCode } from '~/lib/shares/codes'

function surnameKey(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts.at(-1) ?? name
}

const roleSchema = z.enum(['user', 'admin'])

// Input for the admin `update` procedure. Email is intentionally omitted: it is
// the magic-link login identity and immutable after invite (see ADR-0017), so it
// is not part of the editable field set. Error callbacks (not literals) so each
// parse resolves the active locale — the schema itself is module-level and
// outlives any single request.
const userInputSchema = z.object({
  name: nameField,
  phone: phoneField,
  role: roleSchema,
})

// Code-only typed errors for the user mutating procedures. Status only; the
// backend stays i18n-free and the client localizes by code (see
// ~/lib/orpc/userErrorMessage). `satisfies` locks the keys to the domain code
// union. CANNOT_ACT_ON_SELF stays a single code — its "delete-self" vs
// "demote-self" phrasing is resolved client-side from the dialog's context.
const userErrors = {
  NOT_FOUND: { status: 404 },
  TARGET_DELETED: { status: 409 },
  CANNOT_ACT_ON_SELF: { status: 403 },
  LAST_ADMIN: { status: 409 },
  ALREADY_ACCEPTED: { status: 409 },
  EMAIL_TAKEN: { status: 409 },
} satisfies Record<UserDomainErrorCode, { status: number }>

// Derive the invite link's expiry from the last send + the shared TTL, so the
// client never needs the constant (and can't drift from the real token life).
function withInviteExpiry<T extends { lastInvitedAt: Date | null }>(row: T) {
  return {
    ...row,
    inviteExpiresAt: row.lastInvitedAt
      ? new Date(row.lastInvitedAt.getTime() + userService.INVITE_EXPIRY_SECONDS * 1000)
      : null,
  }
}

export const userRouter = {
  me: protectedProcedure.handler(async ({ context }) => {
    const fresh = await auth.api.getSession({
      headers: context.headers,
      query: { disableCookieCache: true },
    })
    return fresh?.user ?? context.user
  }),

  // Self-service profile update (onboarding wizard, per-step). Always scoped to
  // the caller's own id — never an input id — so it needs no admin gate.
  updateProfile: protectedProcedure
    .errors(userErrors)
    .input(selfProfileSchema)
    .handler(async ({ input, context, errors }) => {
      try {
        const updated = await userService.updateOwnProfile(context.user.id, input)
        context.log.info('user updated own profile', { userId: context.user.id })
        // Name/phone show up in the contact list, so refresh other tabs.
        await realtime.publish(
          { kind: 'user.changed', ids: [updated.id] },
          { source: context.user.id },
        )
        return updated
      } catch (err) {
        if (err instanceof UserDomainError) throw errors[err.code]()
        throw err
      }
    }),

  // Stamp onboarding complete (wizard final step). Lets the _authenticated
  // loader stop redirecting the caller into /onboarding.
  completeOnboarding: protectedProcedure.errors(userErrors).handler(async ({ context, errors }) => {
    try {
      const updated = await userService.completeOnboarding(context.user.id)
      context.log.info('user completed onboarding', { userId: context.user.id })
      // No realtime publish: this op only stamps `onboardedAt`, which isn't
      // rendered anywhere, so a `user.changed` would invalidate the whole
      // orpc.user namespace in every other tab for nothing. (updateProfile
      // still publishes — name/phone DO show in the contact list.)
      return updated
    } catch (err) {
      if (err instanceof UserDomainError) throw errors[err.code]()
      throw err
    }
  }),

  findIdByEmail: adminProcedure
    .input(z.object({ email: z.email() }))
    .handler(({ input }) => userService.findIdByEmail(input.email)),

  list: adminProcedure
    .input(z.object({ filter: z.enum(['active', 'deleted']).default('active') }))
    .handler(async ({ input }) => {
      const rows =
        input.filter === 'deleted' ? await userService.listDeleted() : await userService.listAll()
      return rows.map(withInviteExpiry)
    }),

  listContacts: protectedProcedure.handler(async ({ context }) => {
    const isAdmin = context.user.role === 'admin'
    const [users, sharesWithOwner] = await Promise.all([
      userService.listAll(),
      shareService.listSharesWithCurrentOwner(),
    ])

    // listSharesWithCurrentOwner is A→J ordered, so per-user lists come out
    // sorted without an extra sort.
    const byUser = new Map<string, Array<ShareCode>>()
    for (const s of sharesWithOwner) {
      if (!s.currentUserId) continue
      const list = byUser.get(s.currentUserId) ?? []
      list.push(s.shareCode)
      byUser.set(s.currentUserId, list)
    }

    return (
      users
        // Pending invitees (emailVerified === false) are admin-only — a regular
        // owner's client never receives their rows. See ADR-0017.
        .filter((u) => isAdmin || u.emailVerified)
        .map((u) => ({ ...withInviteExpiry(u), shares: byUser.get(u.id) ?? [] }))
        .sort(
          (a, b) =>
            // Pending invitees (admin-only) sort as a group after accepted users;
            // within each group, by surname.
            Number(b.emailVerified) - Number(a.emailVerified) ||
            surnameKey(a.name).localeCompare(surnameKey(b.name), 'sv-SE') ||
            a.name.localeCompare(b.name, 'sv-SE'),
        )
    )
  }),

  getById: adminProcedure
    .errors(userErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, errors }) => {
      const target = await userService.findActiveById(input.id)
      if (!target) throw errors.NOT_FOUND()
      return target
    }),

  invite: adminProcedure
    .errors(userErrors)
    .input(inviteInputSchema)
    .handler(async ({ input, context, errors }) => {
      // inviteUser normalizes the email itself (EMAIL_TAKEN check + insert).
      let created: Awaited<ReturnType<typeof userService.inviteUser>>
      try {
        created = await userService.inviteUser(input.email)
      } catch (err) {
        if (err instanceof UserDomainError) throw errors[err.code]()
        throw err
      }
      context.log.info('admin invited user', { targetId: created.id })
      await realtime.publish(
        { kind: 'user.changed', ids: [created.id] },
        { source: context.user.id },
      )
      // Mint + send the verify-email invite. Called WITHOUT session headers: the
      // no-session branch resolves the user by email and sends; the admin's
      // headers would hit the session branch → EMAIL_MISMATCH (invitee ≠ admin).
      // This resolves once the 7-day token is minted, but the email itself is
      // enqueued by the sendVerificationEmail hook fire-and-forget (tier-3, see
      // auth.ts) — so an enqueue/delivery failure is logged server-side, not
      // surfaced here. The user row already exists; if no mail arrives the admin
      // resends. The try/catch only guards a synchronous trigger error.
      try {
        await auth.api.sendVerificationEmail({ body: { email: created.email, callbackURL: '/' } })
      } catch (err) {
        context.log.warn('invite email trigger failed', { targetId: created.id, err })
      }
      return withInviteExpiry(created)
    }),

  resendInvite: adminProcedure
    .errors(userErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      let target: Awaited<ReturnType<typeof userService.assertInviteResendable>>
      try {
        target = await userService.assertInviteResendable(input.id)
      } catch (err) {
        if (err instanceof UserDomainError) throw errors[err.code]()
        throw err
      }
      // sendVerificationEmail mints a fresh 7-day token synchronously; the email
      // is then enqueued fire-and-forget (tier-3, see auth.ts), so enqueue/
      // delivery failures are logged server-side rather than surfaced. markInvited
      // resets the countdown to match the freshly-minted token. (If the invitee
      // raced us and verified in between, the no-session branch no-ops; the stamp
      // is harmless then — the pending badge/countdown only render while
      // emailVerified is false.)
      await auth.api.sendVerificationEmail({ body: { email: target.email, callbackURL: '/' } })
      await userService.markInvited(target.id)
      context.log.info('admin resent invite', { targetId: target.id })
      await realtime.publish(
        { kind: 'user.changed', ids: [target.id] },
        { source: context.user.id },
      )
    }),

  update: adminProcedure
    .errors(userErrors)
    .input(userInputSchema.extend({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      try {
        const updated = await userService.updateAsAdmin(context.user.id, input.id, {
          name: input.name,
          phone: input.phone,
          role: input.role,
        })
        context.log.info('admin updated user', { targetId: input.id, role: input.role })
        await realtime.publish(
          { kind: 'user.changed', ids: [updated.id] },
          { source: context.user.id },
        )
        return updated
      } catch (err) {
        if (err instanceof UserDomainError) throw errors[err.code]()
        throw err
      }
    }),

  delete: adminProcedure
    .errors(userErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      try {
        await userService.softDeleteAsAdmin(context.user.id, input.id)
      } catch (err) {
        if (err instanceof UserDomainError) throw errors[err.code]()
        throw err
      }
      await auth.api.revokeUserSessions({
        body: { userId: input.id },
        headers: context.headers,
      })
      context.log.info('admin soft-deleted user', { targetId: input.id })
      await realtime.publish({ kind: 'user.changed', ids: [input.id] }, { source: context.user.id })
    }),

  restore: adminProcedure
    .errors(userErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      try {
        await userService.restoreAsAdmin(input.id)
      } catch (err) {
        if (err instanceof UserDomainError) throw errors[err.code]()
        throw err
      }
      context.log.info('admin restored user', { targetId: input.id })
      await realtime.publish({ kind: 'user.changed', ids: [input.id] }, { source: context.user.id })
    }),
}
