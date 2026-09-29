import type { IntegrationSource } from '~/lib/integrationHealth'

const HOUR_MS = 60 * 60 * 1000

// Domain rule: how long after its last success a source counts as `stale`.
// Zaptec syncs hourly, so 3 h = two missed runs. elpris/skoda are placeholders
// until their phases land (a daily sync + slack).
export const STALE_AFTER_MS: Record<IntegrationSource, number> = {
  zaptec: 3 * HOUR_MS,
  elpris: 26 * HOUR_MS,
  skoda: 26 * HOUR_MS,
}

// A sync lease outlives the function's maxDuration, so a crashed run's lease
// expires and the next run takes over.
export const LEASE_DURATION_MS = 5 * 60 * 1000

// Run history older than this is pruned on every recorded outcome.
export const RUN_RETENTION_MS = 90 * 24 * HOUR_MS
