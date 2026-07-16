import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { normalizeEmail } from '~/lib/adminAllowlist'
import {
  clearBrowserSession as clearCookie,
  readBrowserSession,
  rememberUser,
} from '~/lib/browserSession'
import { findAvatarByEmail } from '~/lib/services/user'

// Name and avatar are resolved here, server-side, from the cookie's own email —
// never from a caller-supplied address. Keeping the lookup cookie-bound means
// there is no endpoint an anonymous visitor can probe with arbitrary emails to
// confirm an account exists (or fetch its name/photo).
export const getBrowserSession = createServerFn({ method: 'GET' }).handler(async () => {
  const session = readBrowserSession()
  if (!session) return null
  const avatar = await findAvatarByEmail(normalizeEmail(session.email))
  return { ...session, ...avatar }
})

export const clearBrowserSession = createServerFn({ method: 'POST' }).handler(() => {
  clearCookie()
})

const rememberBrowserUserSchema = z.object({
  email: z.email(),
  userId: z.uuid(),
})

export const rememberBrowserUser = createServerFn({ method: 'POST' })
  .validator(rememberBrowserUserSchema)
  .handler(async ({ data }) => {
    await rememberUser(data.userId, data.email)
  })
