import { z } from 'zod'
import { auth, resolveBaseURL } from '~/lib/auth'
import { queue, realtime } from '~/lib/effects'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import { inviteInputSchema } from '~/lib/orpc/userInviteSchema'
import { nameField, phoneField, selfProfileSchema } from '~/lib/orpc/userProfileSchema'
import * as userService from '~/lib/services/user'
import { UserDomainError, type UserDomainErrorCode } from '~/lib/services/user'
import { baseLocale } from '~/paraglide/runtime'

const roleSchema = z.enum(['user', 'admin'])

// Input for the admin `updateAsAdmin` procedure. Email is intentionally
// omitted: it is the sign-in identity and immutable after invite (see
// ADR-0017), so it is not part of the editable field set. Error callbacks (not
// literals) so each parse resolves the active locale — the schema itself is
// module-level and outlives any single request.
const userInputSchema = z.object({
  name: nameField,
  phone: phoneField,
  role: roleSchema,
})

// Code-only typed errors for the user mutating procedures. Status only; the
// backend stays i18n-free and the client localizes by code (see
// ~/lib/orpc/userErrorMessage). `satisfies` locks the keys to the domain code
// union. CANNOT_ACT_ON_SELF stays a single code — its "can't revoke yourself"
// vs "can't demote yourself" phrasing is resolved client-side from the
// dialog's context.
const userErrors = {
  NOT_FOUND: { status: 404 },
  TARGET_DELETED: { status: 409 },
  CANNOT_ACT_ON_SELF: { status: 403 },
  LAST_ADMIN: { status: 409 },
  ALREADY_ACCEPTED: { status: 409 },
  EMAIL_ALREADY_APPROVED: { status: 409 },
} satisfies Record<UserDomainErrorCode, { status: number }>

// The invite/resend email links straight to /login rather than a minted
// magic-link or verify token: per the Better Auth docs, the magic-link
// plugin's only server entry point (`auth.api.signInMagicLink`) fires the
// plugin's own configured `sendMagicLink` callback and does not return the
// token/URL to the caller, so there is no supported way to mint a link here
// for a *different* (invite-branded) email without re-implementing token
// issuance. The invitee is already on the approved_email allowlist by the
// time this link is sent, so /login's existing Google + magic-link paths just
// work once they arrive. See ADR-0017 amendment.
function buildInviteUrl(): string {
  return `${resolveBaseURL()}/login`
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
        // Name/phone show up in the users directory, so refresh other tabs.
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
      // still publishes — name/phone DO show in the users directory.)
      return updated
    } catch (err) {
      if (err instanceof UserDomainError) throw errors[err.code]()
      throw err
    }
  }),

  // Read — any signed-in (approved) user, not just admins: the whole app is
  // read-only for non-admins, reads are open. Active users + pending invites,
  // each tagged `status` (see ADR-0017 amendment).
  list: protectedProcedure.handler(() => userService.listUsersAndPending()),

  invite: adminProcedure
    .errors(userErrors)
    .input(inviteInputSchema)
    .handler(async ({ input, context, errors }) => {
      let created: Awaited<ReturnType<typeof userService.inviteUser>>
      try {
        created = await userService.inviteUser({
          email: input.email,
          role: input.role,
          actorUserId: context.user.id,
        })
      } catch (err) {
        if (err instanceof UserDomainError) throw errors[err.code]()
        throw err
      }
      context.log.info('admin invited user', { email: created.email, role: created.role })
      await realtime.publish({ kind: 'user.changed' }, { source: context.user.id })
      // Courtesy email — a queued job renders + sends with retry/backoff (tier-3,
      // see ADR-0007/0008); a failure here would only affect that email, so it
      // isn't wrapped in a try/catch guard — the admin sees it fail loudly and
      // can retry via resendInvite instead of silently losing the invite.
      await queue.publish('email_user_invited', {
        to: created.email,
        inviteUrl: buildInviteUrl(),
        locale: baseLocale,
      })
      return created
    }),

  resendInvite: adminProcedure
    .errors(userErrors)
    .input(z.object({ email: z.email() }))
    .handler(async ({ input, context, errors }) => {
      let target: Awaited<ReturnType<typeof userService.assertPendingInvite>>
      try {
        target = await userService.assertPendingInvite(input.email)
      } catch (err) {
        if (err instanceof UserDomainError) throw errors[err.code]()
        throw err
      }
      context.log.info('admin resent invite', { email: target.email })
      await queue.publish('email_user_invited', {
        to: target.email,
        inviteUrl: buildInviteUrl(),
        locale: baseLocale,
      })
    }),

  revoke: adminProcedure
    .errors(userErrors)
    .input(z.object({ email: z.email() }))
    .handler(async ({ input, context, errors }) => {
      let result: Awaited<ReturnType<typeof userService.revokeUser>>
      try {
        result = await userService.revokeUser({ email: input.email, actorUserId: context.user.id })
      } catch (err) {
        if (err instanceof UserDomainError) throw errors[err.code]()
        throw err
      }
      // Only a real user (one who already signed in at least once) can have
      // live sessions to revoke — a still-pending invite never had any.
      if (result.userId) {
        await auth.api.revokeUserSessions({
          body: { userId: result.userId },
          headers: context.headers,
        })
      }
      context.log.info('admin revoked user access', { email: input.email, targetId: result.userId })
      await realtime.publish(
        { kind: 'user.changed', ids: result.userId ? [result.userId] : [] },
        { source: context.user.id },
      )
    }),

  updateAsAdmin: adminProcedure
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
}
