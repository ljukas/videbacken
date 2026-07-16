const adminEmails = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

export const normalizeEmail = (email: string): string => email.toLowerCase()

export const isAllowlistedAdmin = (email: string): boolean =>
  adminEmails.includes(normalizeEmail(email))
