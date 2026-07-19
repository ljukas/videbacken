import { PencilIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { formatDistanceShort } from '~/lib/i18n/format'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'

type Device = RouterOutputs['sensor']['listDevices'][number]

// A stat tile per device: its latest temperature/humidity, battery, and how long
// ago it was last seen. Admins get an inline edit affordance (name/location).
export function CurrentReadingTiles({
  devices,
  isAdmin,
  onEdit,
}: {
  devices: Device[]
  isAdmin: boolean
  onEdit: (id: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {devices.map((d) => (
        <Card key={d.id}>
          {/* CardHeader is a grid that only makes room for a trailing action
              when a CardAction (data-slot="card-action") is present, so the edit
              button must be wrapped in CardAction to sit beside the title. */}
          <CardHeader className="pb-2">
            <CardTitle className="truncate text-sm">{d.displayName}</CardTitle>
            {isAdmin ? (
              <CardAction>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => onEdit(d.id)}
                  aria-label={m.sensors_edit_device()}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent>
            <div className="font-semibold text-2xl tabular-nums">
              {d.latest?.temperatureC != null ? `${d.latest.temperatureC.toFixed(1)}°C` : '—'}
            </div>
            <div className="text-muted-foreground text-sm tabular-nums">
              {d.latest?.humidityPct != null ? `${d.latest.humidityPct.toFixed(0)}%` : '—'}
            </div>
            {/* The "last seen" distance is measured against `new Date()`, which
                differs by ~1s between SSR and hydration — an expected, benign
                mismatch, so suppress the hydration warning (React's documented
                use for timestamps). The 60s poll re-renders it with the fresh
                value. */}
            <div className="mt-2 text-muted-foreground text-xs" suppressHydrationWarning>
              {d.batteryPct != null ? m.sensors_battery({ pct: d.batteryPct }) : null}
              {d.batteryPct != null && d.lastSeenAt ? ' · ' : null}
              {d.lastSeenAt
                ? m.sensors_last_seen({ time: formatDistanceShort(d.lastSeenAt) })
                : null}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
