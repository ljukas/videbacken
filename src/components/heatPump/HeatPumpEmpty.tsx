import { AirVentIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { m } from '~/paraglide/messages'

// No heat pump readings yet (ADR-0016, spec "Error handling": names Comfort Cloud): only data says so, never a skeleton.
export function HeatPumpEmpty() {
  return (
    <Empty className="brand-wash rounded-lg border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AirVentIcon />
        </EmptyMedia>
        <EmptyTitle>{m.heat_pump_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.heat_pump_empty_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
