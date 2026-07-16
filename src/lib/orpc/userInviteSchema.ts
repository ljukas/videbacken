import { z } from 'zod'
import { m } from '~/paraglide/messages'

/**
 * The invite input contract, shared by the oRPC `user.invite` procedure
 * (`.input(...)`) and the `InviteUserDialog` form (`validators.onSubmit`) so the
 * client and server can't validate differently. Pure Zod + Paraglide — no
 * server/db imports — so it's safe to pull into the client bundle. Lazy message
 * callbacks resolve the active locale per parse (the schema is module-level).
 *
 * Invite is email-only: name/phone/avatar are collected later in onboarding and
 * every invitee starts as `user`.
 */
export const inviteInputSchema = z.object({
  email: z
    .email({ error: () => m.validation_email_invalid() })
    .min(1, { error: () => m.validation_email_required() }),
})
