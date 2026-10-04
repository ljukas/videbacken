import type { IntegrationSource } from '~/lib/integrationHealth'
import { m } from '~/paraglide/messages'

// What each integration gives the page and how often it's fetched, for the
// Datakällor panel. Exhaustive switches with no default — a new source is a
// compile error until it has copy here (and a mark in SyncSourceMark.tsx).

/** What the source provides ("Laddsessioner"). */
export function syncSourceRole(source: IntegrationSource): string {
  switch (source) {
    case 'zaptec':
      return m.charging_source_role_zaptec()
    case 'elpris':
      return m.charging_source_role_elpris()
    case 'skoda':
      return m.charging_source_role_skoda()
    case 'emaldo':
      return m.charging_source_role_emaldo()
  }
}

/** How often its cron fetches it — mirrors the crons in vite.config.ts. */
export function syncSourceCadence(source: IntegrationSource): string {
  switch (source) {
    case 'zaptec':
      return m.charging_source_cadence_zaptec()
    case 'elpris':
      return m.charging_source_cadence_elpris()
    case 'skoda':
      return m.charging_source_cadence_skoda()
    case 'emaldo':
      return m.charging_source_cadence_emaldo()
  }
}
