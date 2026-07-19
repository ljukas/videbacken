import { PencilIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
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
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="truncate text-sm">{d.displayName}</CardTitle>
            {isAdmin ? (
              <Button
                variant="ghost"
                size="icon"
                className="-mr-2 size-7 shrink-0"
                onClick={() => onEdit(d.id)}
                aria-label={m.sensors_edit_device()}
              >
                <PencilIcon className="size-3.5" />
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            <div className="font-semibold text-2xl tabular-nums">
              {d.latest?.temperatureC != null ? `${d.latest.temperatureC.toFixed(1)}°C` : '—'}
            </div>
            <div className="text-muted-foreground text-sm tabular-nums">
              {d.latest?.humidityPct != null ? `${d.latest.humidityPct.toFixed(0)}%` : '—'}
            </div>
            <div className="mt-2 text-muted-foreground text-xs">
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
