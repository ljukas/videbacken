import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import type { useSyncNow } from '~/components/evCharging/SyncNowButton'
import type { SourceHealth } from '~/components/evCharging/syncHealth'
import type { IntegrationSource } from '~/lib/integrationHealth'

// The Energi pages' sources (heat pumps step 2): Emaldo (the house) and Comfort Cloud (the heat pumps). Each alert
// renders only when its source is unhealthy; the heading's "senast synkad" stays Emaldo's.
const ENERGY_SOURCES = ['emaldo', 'comfortCloud'] as const satisfies readonly IntegrationSource[]

export function EnergySyncAlerts({
  health,
  isAdmin,
  syncNow,
}: {
  health: Partial<Record<IntegrationSource, SourceHealth>> | undefined
  isAdmin: boolean
  syncNow: ReturnType<typeof useSyncNow>
}) {
  return (
    <>
      {ENERGY_SOURCES.map((source) => {
        const h = health?.[source]
        return h ? (
          <SyncHealthAlert
            key={source}
            health={h}
            isAdmin={isAdmin}
            onRetry={() => syncNow.syncSource(source)}
            retrying={syncNow.isPendingFor(source)}
          />
        ) : null
      })}
    </>
  )
}
