import { millisecondsInDay, millisecondsInHour, millisecondsInMinute } from 'date-fns/constants'
import type { IntegrationSource } from '~/lib/integrationHealth'

// Domain rule: how long after its last success a source counts as `stale`.
// Zaptec syncs hourly, so 3 h = two missed runs. elpris runs at 12:30 and
// 15:30 UTC (at most 21 h apart), so 26 h = a whole missed day plus slack.
// skoda is a placeholder until its phase lands.
export const STALE_AFTER_MS: Record<IntegrationSource, number> = {
  zaptec: 3 * millisecondsInHour,
  elpris: 26 * millisecondsInHour,
  skoda: 26 * millisecondsInHour,
}

// A sync lease outlives the function's maxDuration, so a crashed run's lease
// expires and the next run takes over.
export const LEASE_DURATION_MS = 5 * millisecondsInMinute

// Run history older than this is pruned on every recorded outcome.
export const RUN_RETENTION_MS = 90 * millisecondsInDay
