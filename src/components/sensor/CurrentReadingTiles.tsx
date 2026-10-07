import { PencilIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { formatDistanceShort } from '~/lib/i18n/format'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'

type Device = RouterOutputs['sensor']['listDevices'][number]

// A tile per device: its name and location, latest temperature/humidity,
// battery, and how long ago it was last seen. Admins get an edit button
// (name/location). Plain bordered tiles: the route's "Just nu" card is the card.
export function CurrentReadingTiles({
  devices,
  isAdmin,
  onEdit,
}: {
  devices: Device[]
  isAdmin: boolean
  onEdit: (id: string) => void
}) {
  // Reserve the location line in every tile once any sensor has one, so the
  // figures line up across a row; with none, no blank line.
  const anyLocation = devices.some((d) => d.location)
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {devices.map((d) => (
        <li key={d.id} className="flex min-w-0 flex-col rounded-lg border p-3">
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-medium text-base">{d.displayName}</h3>
              {anyLocation ? (
                <p data-slot="sensor-location" className="truncate text-muted-foreground text-sm">
                  {/* A non-breaking space keeps an empty line its height. */}
                  {d.location || ' '}
                </p>
              ) : null}
            </div>
            {isAdmin ? (
              <Button
                variant="ghost"
                size="icon"
                // 40 px target; the negative margin keeps it from pushing the name down.
                className="-mt-2 -mr-2 size-10 shrink-0"
                onClick={() => onEdit(d.id)}
                aria-label={m.sensors_edit_device_named({ name: d.displayName })}
              >
                <PencilIcon aria-hidden className="size-4" />
              </Button>
            ) : null}
          </div>
          <div className="mt-2 font-semibold text-3xl tabular-nums">
            {d.latest?.temperatureC != null ? `${d.latest.temperatureC.toFixed(1)}°C` : '—'}
          </div>
          <div className="text-base text-muted-foreground tabular-nums">
            {d.latest?.humidityPct != null ? `${d.latest.humidityPct.toFixed(0)}%` : '—'}
          </div>
          {/* The "last seen" distance is measured against `new Date()`, which
              differs by ~1s between SSR and hydration — an expected, benign
              mismatch, so suppress the hydration warning (React's documented
              use for timestamps). The 60s poll re-renders it with the fresh
              value. */}
          <div className="mt-2 text-muted-foreground text-sm" suppressHydrationWarning>
            {d.batteryPct != null ? m.sensors_battery({ pct: d.batteryPct }) : null}
            {d.batteryPct != null && d.lastSeenAt ? ' · ' : null}
            {d.lastSeenAt ? m.sensors_last_seen({ time: formatDistanceShort(d.lastSeenAt) }) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
