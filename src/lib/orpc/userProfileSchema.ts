import { z } from 'zod'
import { m } from '~/paraglide/messages'

/**
 * Name/phone field validators shared by every user-profile form so the client
 * and server can't validate differently: the admin `user.update` procedure, the
 * self-service `user.updateProfile` procedure, and the onboarding wizard's
 * per-step client forms. Pure Zod + Paraglide — no server/db imports — so it's
 * safe to pull into the client bundle (same convention as `userInviteSchema`).
 * Lazy message callbacks resolve the active locale per parse (the schemas are
 * module-level). See ADR-0017.
 */
export const nameField = z
  .string()
  .trim()
  .min(1, { error: () => m.validation_name_required() })
  .max(255, { error: () => m.validation_name_too_long() })

export const phoneField = z
  .string()
  .max(30, { error: () => m.validation_phone_too_long() })
  .refine((v) => v === '' || v.length >= 5, { error: () => m.validation_phone_too_short() })

// Self-service profile patch used by the onboarding wizard. Both fields optional
// so each wizard step can submit just its own input. No `role` (a user can't
// change their own role) and no `email` (immutable login identity — see
// ADR-0017).
export const selfProfileSchema = z.object({
  name: nameField.optional(),
  phone: phoneField.optional(),
})
