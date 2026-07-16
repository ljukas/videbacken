import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { approvedEmail } from '../../db/schema'
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

export async function removeApproved(email: string): Promise<void> {
  await db.delete(approvedEmail).where(eq(approvedEmail.email, normalizeEmail(email)))
}
