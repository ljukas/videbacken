import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { z } from 'zod'

// Cookie written by Better Auth's lastLoginMethod plugin (registered in
// src/lib/auth.ts). Plain, unsigned string value; client-readable.
export const LAST_LOGIN_METHOD_COOKIE = 'better-auth.last_used_login_method'

// Narrow the plugin's raw string to the two methods this app supports; any
// other value (absent cookie, a future provider) → null → magic-link default.
const loginMethodSchema = z.enum(['google', 'magic-link'])
export type LoginMethod = z.infer<typeof loginMethodSchema>

export const getLastLoginMethod = createServerFn({ method: 'GET' }).handler(() => {
  const parsed = loginMethodSchema.safeParse(getCookie(LAST_LOGIN_METHOD_COOKIE))
  return parsed.success ? parsed.data : null
})
