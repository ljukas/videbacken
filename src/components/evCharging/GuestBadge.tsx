// Marks a session another car charged (ADR-0021); our own carry none.
import { Badge } from '~/components/ui/badge'
import { m } from '~/paraglide/messages'

export function GuestBadge() {
  return (
    <Badge variant="outline">
      <span className="sr-only">{m.charging_vehicle_who_label()}: </span>
      {m.charging_vehicle_guest_badge()}
    </Badge>
  )
}
