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

/** The key button's id, so a dialog opened from a link or URL can return focus to it. */
export const credentialsButtonId = (source: CredentialSource) => `credentials-${source}`
