import type { IntegrationSource } from '~/lib/integrationHealth'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'

/** One source's sync health, as the pages read it. */
export type SourceHealth = RouterOutputs['evCharging']['syncStatuses'][IntegrationSource]

// Every source's health in one read (ADR-0025 §5): one cache entry shared by
// every page, polled by the page that shows it. A page reads its sources with
// `data?.[source]`.
export const syncHealthQuery = orpc.evCharging.syncStatuses.queryOptions()
