// Client-safe copy layer over `~/lib/integrationHealth`'s dependency-free
// vocabulary. `import type` only from that module (never a value) plus the
// Paraglide `m` messages — no `db`, no server-only import — so the `/charging`
// health badge can import this straight into the browser bundle. Same
// client-safe pattern as `src/lib/sensor/range.ts`.
//
// `integrationErrorMessage` and `integrationHealthTitle` take an explicit
// optional `locale` because `integrationErrorMessage` is also called from the
// queue-worker email template (`src/emails/IntegrationSyncAlertEmail.tsx`),
// which renders outside any request scope — the ambient Paraglide locale
// isn't available there (see the same note on `src/emails/InviteUserEmail.tsx`).
// `integrationSourceName` doesn't take one: source names are brand/proper
// nouns with identical sv/en copy, so the ambient ("ok in any context") lookup
// is always correct.
//
// Every switch is exhaustive with no `default` — adding a new
// `IntegrationSource` / `IntegrationErrorCode` / `HealthState` is a compile
// error here until copy is added for it.
import type { HealthState, IntegrationErrorCode, IntegrationSource } from '~/lib/integrationHealth'
import { m } from '~/paraglide/messages'
import type { Locale } from '~/paraglide/runtime'

export function integrationSourceName(source: IntegrationSource): string {
  switch (source) {
    case 'zaptec':
      return m.integration_health_source_zaptec()
    case 'elpris':
      return m.integration_health_source_elpris()
    case 'skoda':
      return m.integration_health_source_skoda()
  }
}

/**
 * The admin-facing explanation of a failure code, naming the source — the same
 * code means the same thing for every integration, only the name differs. The
 * source is required so no caller can fall back to one integration's wording.
 */
export function integrationErrorMessage(
  code: IntegrationErrorCode,
  options: { source: IntegrationSource; locale?: Locale },
): string {
  const opts = { locale: options.locale }
  const source = integrationSourceName(options.source)
  switch (code) {
    case 'auth_failed':
      // An expired key is the expected Škoda failure; say what fixes it.
      return options.source === 'skoda'
        ? m.integration_health_error_auth_failed_skoda({}, opts)
        : m.integration_health_error_auth_failed({ source }, opts)
    case 'forbidden':
      return m.integration_health_error_forbidden({ source }, opts)
    case 'rate_limited':
      return m.integration_health_error_rate_limited({ source }, opts)
    case 'unreachable':
      return m.integration_health_error_unreachable({ source }, opts)
    case 'unexpected_response':
      return m.integration_health_error_unexpected_response({ source }, opts)
    case 'not_configured':
      return m.integration_health_error_not_configured({ source }, opts)
    case 'internal_error':
      return m.integration_health_error_internal_error({}, opts)
  }
}

export function integrationHealthTitle(state: HealthState, options?: { locale?: Locale }): string {
  const opts = { locale: options?.locale }
  switch (state) {
    case 'never_synced':
      return m.integration_health_state_never_synced({}, opts)
    case 'not_configured':
      return m.integration_health_state_not_configured({}, opts)
    case 'ok':
      return m.integration_health_state_ok({}, opts)
    case 'stale':
      return m.integration_health_state_stale({}, opts)
    case 'failing':
      return m.integration_health_state_failing({}, opts)
  }
}
