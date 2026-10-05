import type { QueryClient } from '@tanstack/react-query'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { INTEGRATION_SOURCES, type IntegrationSource } from '~/lib/integrationHealth'

const okHealth = (source: IntegrationSource) => ({
  source,
  state: 'ok',
  running: false,
  progress: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  failingSince: null,
  consecutiveFailures: 0,
  code: null,
  adminDetail: null,
})

/** Seeds the pages' one health read: every source ok, unless overridden (merged over ok). */
export function seedSourcesHealth(
  qc: QueryClient,
  overrides: Partial<Record<IntegrationSource, Record<string, unknown>>> = {},
) {
  qc.setQueryData(
    syncHealthQuery.queryKey,
    Object.fromEntries(
      INTEGRATION_SOURCES.map((source) => [source, { ...okHealth(source), ...overrides[source] }]),
    ) as never,
  )
}
