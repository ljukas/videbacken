import { millisecondsInDay, millisecondsInHour, millisecondsInMinute } from 'date-fns/constants'
import type { IntegrationSource } from '~/lib/integrationHealth'

// Domain rule: how long after its last success a source counts as `stale`.
// Zaptec syncs hourly, so 3 h = two missed runs. elpris runs at 12:30 and
// 15:30 UTC (at most 21 h apart), so 26 h = a whole missed day plus slack.
// skoda polls every 15 min, so 1 h = three missed polls. Emaldo syncs hourly
// (:45), so 3 h like Zaptec.
export const STALE_AFTER_MS: Record<IntegrationSource, number> = {
  zaptec: 3 * millisecondsInHour,
  elpris: 26 * millisecondsInHour,
  skoda: millisecondsInHour,
  emaldo: 3 * millisecondsInHour,
}

// How many consecutive alertable failures open an alert email (a
// not_configured run restarts the count). Hourly/daily
// sources alert at once; Škoda polls every 15 min, where a single 503 or 429
// would otherwise email every admin and then "recovered" 15 min later.
export const ALERT_AFTER_FAILURES: Record<IntegrationSource, number> = {
  zaptec: 1,
  elpris: 1,
  skoda: 3,
  emaldo: 1,
}

// A sync lease outlives the function's maxDuration, so a crashed run's lease
// expires and the next run takes over.
export const LEASE_DURATION_MS = 5 * millisecondsInMinute

// Run history older than this is pruned on every recorded outcome.
export const RUN_RETENTION_MS = 90 * millisecondsInDay
