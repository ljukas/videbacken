import { BellIcon, PencilIcon } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
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
  alertCounts,
  onOpenAlerts,
}: {
  devices: Device[]
  isAdmin: boolean
  onEdit: (id: string) => void
  /** The viewer's switched-on rules per device; missing = 0. */
  alertCounts: Record<string, number>
  onOpenAlerts: (id: string) => void
}) {
  // Reserve the location line in every tile once any sensor has one, so the
  // figures line up across a row; with none, no blank line.
  const anyLocation = devices.some((d) => d.location)
  return (
    // Columns follow the tiles' own width (container query), not the viewport.
    // Each tile must fit its 30 px figure and leave its name room beside the two
    // 40 px buttons: one column below a 19rem container (a 320 px phone leaves
    // ~256 px), two from there, four only from @2xl, which a tablet with the
    // sidebar open doesn't reach.
    <div className="@container">
      <ul className="grid grid-cols-1 gap-3 @[19rem]:grid-cols-2 @2xl:grid-cols-4">
        {devices.map((d) => (
          <li key={d.id} className="flex min-w-0 flex-col rounded-lg border p-3">
            {/* Only the name shares its row with the buttons; the location gets
                the tile's full width below. */}
            <div data-slot="sensor-tile-header" className="flex items-start gap-1">
              {/* Wraps to two lines rather than collapsing beside the buttons on a phone. */}
              <h3 className="line-clamp-2 min-w-0 flex-1 break-words font-medium text-base">
                {d.displayName}
              </h3>
              {/* 40 px targets. The group pulls into the tile's padding (top and
                  right) so the icons line up with the name, not the name with them. */}
              <div className="-mt-2 -mr-2 flex shrink-0 items-start">
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative size-10"
                  onClick={() => onOpenAlerts(d.id)}
                  aria-label={
                    (alertCounts[d.id] ?? 0) > 0
                      ? m.sensors_alerts_open_named_count({
                          name: d.displayName,
                          count: alertCounts[d.id] ?? 0,
                        })
                      : m.sensors_alerts_open_named({ name: d.displayName })
                  }
                >
                  <BellIcon aria-hidden className="size-4" />
                  {(alertCounts[d.id] ?? 0) > 0 ? (
                    <Badge
                      variant="secondary"
                      aria-hidden
                      className="pointer-events-none absolute top-0.5 right-0.5 h-4 min-w-4 px-1 py-0 text-sm tabular-nums leading-none"
                    >
                      {alertCounts[d.id]}
                    </Badge>
                  ) : null}
                </Button>
                {isAdmin ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-10 shrink-0"
                    onClick={() => onEdit(d.id)}
                    aria-label={m.sensors_edit_device_named({ name: d.displayName })}
                  >
                    <PencilIcon aria-hidden className="size-4" />
                  </Button>
                ) : null}
              </div>
            </div>
            {anyLocation ? (
              <p data-slot="sensor-location" className="truncate text-muted-foreground text-sm">
                {/* A non-breaking space keeps an empty line its height. */}
                {d.location || ' '}
              </p>
            ) : null}
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
              {d.lastSeenAt
                ? m.sensors_last_seen({ time: formatDistanceShort(d.lastSeenAt) })
                : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
