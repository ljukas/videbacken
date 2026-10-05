import { formatAgo } from '~/components/evCharging/format'
import { m } from '~/paraglide/messages'

// The Energi pages' heading: the view's title, what the data is, and when
// Emaldo last synced (ChargingHeading's shape, without its charging notes).
export function EnergyHeading({
  title,
  lastSuccessAt,
}: {
  title: string
  lastSuccessAt: Date | null
}) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">{title}</h1>
      <p className="max-w-2xl text-muted-foreground text-sm">{m.energy_description()}</p>
      {/* Relative time differs slightly between SSR and hydration (as in ChargingHeading). */}
      <p className="text-muted-foreground text-xs" suppressHydrationWarning>
        {lastSuccessAt
          ? m.charging_last_synced({ time: formatAgo(lastSuccessAt) })
          : m.charging_never_synced()}
      </p>
    </header>
  )
}
