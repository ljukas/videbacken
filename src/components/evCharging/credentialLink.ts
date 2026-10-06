import { type CredentialSource, isCredentialSource } from '~/lib/integrationCredentials'
import type { SourceHealth } from './syncHealth'

export type CredentialLink = { source: CredentialSource; kind: 'configure' | 'update' }

/**
 * Whether a source's health points at its credentials, and so links into the credentials dialog:
 * unconfigured → "Konfigurera"; a refused or unreadable sign-in, Škoda's forbidden (key or VIN), or any
 * failure the sync blamed on named fields → "Uppdatera inloggning". Elpris has no credentials.
 */
export function credentialLink(health: SourceHealth): CredentialLink | null {
  const { source } = health
  if (!isCredentialSource(source)) return null
  if (health.state === 'not_configured') return { source, kind: 'configure' }
  if (health.state === 'ok' || health.code === null) return null
  const credentialCode =
    health.code === 'auth_failed' ||
    health.code === 'credentials_unreadable' ||
    (source === 'skoda' && health.code === 'forbidden')
  const suspects = (health.adminDetail?.suspectFields?.length ?? 0) > 0
  return credentialCode || suspects ? { source, kind: 'update' } : null
}

type SuspectFields = NonNullable<NonNullable<SourceHealth['adminDetail']>['suspectFields']>

/**
 * The fields the last failed sync blamed, while they still describe what is saved: a save newer than
 * that attempt replaced the blamed values, so they no longer count — until the next attempt (the
 * post-save sync can be skipped by the lease, or read the old values on a warm instance's 60 s cache,
 * ADR-0026). `updatedAt` is the source's `credentials.status` save time: null (nothing stored) or
 * undefined (status not known) keeps them.
 */
export function currentSuspectFields(
  health: SourceHealth | undefined,
  updatedAt: Date | null | undefined,
): SuspectFields {
  const fields = health?.adminDetail?.suspectFields ?? []
  if (!updatedAt) return fields
  const attempt = health?.lastAttemptAt
  return attempt && attempt.getTime() >= updatedAt.getTime() ? fields : []
}

/** The key button's id, so a dialog opened from a link or URL can return focus to it. */
export const credentialsButtonId = (source: CredentialSource) => `credentials-${source}`
