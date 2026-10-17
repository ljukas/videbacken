import { eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { approvedEmail } from '~/lib/db/schema'
import { ApprovedEmailDomainError } from './errors'

export type ApprovedEmailRow = typeof approvedEmail.$inferSelect

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

export async function isApproved(email: string): Promise<{ role: 'user' | 'admin' } | null> {
  const [row] = await db
    .select({ role: approvedEmail.role })
    .from(approvedEmail)
    .where(eq(approvedEmail.email, normalizeEmail(email)))
    .limit(1)
  return row ?? null
}

export async function listApproved(): Promise<ApprovedEmailRow[]> {
  return db.select().from(approvedEmail).orderBy(approvedEmail.createdAt)
}

export async function addApproved(input: {
  email: string
  role: 'user' | 'admin'
  addedByUserId: string | null
}): Promise<ApprovedEmailRow> {
  const email = normalizeEmail(input.email)
  if (await isApproved(email)) throw new ApprovedEmailDomainError('EMAIL_ALREADY_APPROVED')
  const [row] = await db
    .insert(approvedEmail)
    .values({ email, role: input.role, addedByUserId: input.addedByUserId })
    .returning()
  return row
}

/**
 * Adds the email unless it is already approved, keeping an existing row and its
 * role. Atomic (`ON CONFLICT DO NOTHING`), so two concurrent callers can't fail
 * on the unique email: the deploy-time seed (two builds at once). True when added.
 */
export async function addApprovedIfMissing(input: {
  email: string
  role: 'user' | 'admin'
  addedByUserId: string | null
}): Promise<boolean> {
  const rows = await db
    .insert(approvedEmail)
    .values({
      email: normalizeEmail(input.email),
      role: input.role,
      addedByUserId: input.addedByUserId,
    })
    .onConflictDoNothing({ target: approvedEmail.email })
    .returning({ id: approvedEmail.id })
  return rows.length > 0
}

/** Whether the allowlist approves any admin: the deploy-time seed only bootstraps (ADR-0017). */
export async function hasApprovedAdmin(): Promise<boolean> {
  const [row] = await db
    .select({ id: approvedEmail.id })
    .from(approvedEmail)
    .where(eq(approvedEmail.role, 'admin'))
    .limit(1)
  return row !== undefined
}

export async function removeApproved(email: string): Promise<void> {
  await db.delete(approvedEmail).where(eq(approvedEmail.email, normalizeEmail(email)))
}
