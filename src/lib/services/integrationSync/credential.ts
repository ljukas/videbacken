import { and, eq, gt, isNull, ne, or } from 'drizzle-orm'
import { db } from '~/lib/db'
import { integrationSync } from '~/lib/db/schema'
import {
  CREDENTIAL_REMINDER_DAYS,
  CREDENTIAL_WARN_DAYS,
  type CredentialReminderDays,
  type IntegrationSource,
} from '~/lib/integrationHealth'

const DAY_MS = 86_400_000

export type CredentialExpiry = { expiresAt: Date; daysLeft: number; warn: boolean }

/** Server-owned policy (never re-derived client-side): days left, rounded up, and whether to warn. */
export function credentialExpiryOf(expiresAt: Date | null, now: Date): CredentialExpiry | null {
  if (!expiresAt) return null
  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS))
  return { expiresAt, daysLeft, warn: daysLeft <= CREDENTIAL_WARN_DAYS }
}

/**
 * Stores the expiry a successful call reported. A changed date (a renewed key)
 * resets the reminder state; null (header missing) keeps what is stored — the
 * caller warns. Expects the source's row to exist (the sync's lease made it).
 */
export async function recordCredentialExpiry(
  source: IntegrationSource,
  expiresAt: Date | null,
): Promise<void> {
  if (!expiresAt) return
  await db
    .update(integrationSync)
    .set({ credentialExpiresAt: expiresAt, credentialReminderDays: null })
    .where(
      and(
        eq(integrationSync.source, source),
        or(
          isNull(integrationSync.credentialExpiresAt),
          ne(integrationSync.credentialExpiresAt, expiresAt),
        ),
      ),
    )
}

export type CredentialReminderClaim = {
  days: CredentialReminderDays
  expiresAt: Date
  /** The reminder state before this claim, so a send that fails can release it. */
  previous: CredentialReminderDays | null
}

/**
 * Claims the reminder now due, if any: the smallest threshold ≥ days left that
 * hasn't been sent for this expiry. The read and the claim share one
 * transaction holding the row lock, so `previous` is never stale and two runs
 * never claim the same reminder (the conditional UPDATE keeps it correct even
 * without the lock); a claim whose emails all fail is released.
 */
export async function claimCredentialReminder(
  source: IntegrationSource,
  now: Date,
): Promise<CredentialReminderClaim | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        expiresAt: integrationSync.credentialExpiresAt,
        sent: integrationSync.credentialReminderDays,
      })
      .from(integrationSync)
      .where(eq(integrationSync.source, source))
      .for('update')
    const expiry = credentialExpiryOf(row?.expiresAt ?? null, now)
    if (!expiry || !row) return null
    const eligible = CREDENTIAL_REMINDER_DAYS.filter((d) => expiry.daysLeft <= d)
    if (eligible.length === 0) return null
    const due = Math.min(...eligible) as CredentialReminderDays
    const [claimed] = await tx
      .update(integrationSync)
      .set({ credentialReminderDays: due })
      .where(
        and(
          eq(integrationSync.source, source),
          eq(integrationSync.credentialExpiresAt, expiry.expiresAt),
          or(
            isNull(integrationSync.credentialReminderDays),
            gt(integrationSync.credentialReminderDays, due),
          ),
        ),
      )
      .returning({ expiresAt: integrationSync.credentialExpiresAt })
    if (!claimed?.expiresAt) return null
    return {
      days: due,
      expiresAt: claimed.expiresAt,
      previous: (row.sent as CredentialReminderDays | null) ?? null,
    }
  })
}

/** Undoes a claim nobody was emailed for, so the next poll tries again. */
export async function releaseCredentialReminder(
  source: IntegrationSource,
  claim: CredentialReminderClaim,
): Promise<void> {
  await db
    .update(integrationSync)
    .set({ credentialReminderDays: claim.previous })
    .where(
      and(
        eq(integrationSync.source, source),
        eq(integrationSync.credentialExpiresAt, claim.expiresAt),
        eq(integrationSync.credentialReminderDays, claim.days),
      ),
    )
}
