// Marks a session another car charged (ADR-0021); our own carry none.
import { Badge } from '~/components/ui/badge'
import { m } from '~/paraglide/messages'

export function GuestBadge() {
  return <Badge variant="outline">{m.charging_vehicle_guest_badge()}</Badge>
}
