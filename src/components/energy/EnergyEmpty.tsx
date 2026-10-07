import { SunIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { m } from '~/paraglide/messages'

// No house readings yet (ADR-0016): only data says so, never a skeleton.
export function EnergyEmpty() {
  return (
    <Empty className="brand-wash rounded-lg border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SunIcon />
        </EmptyMedia>
        <EmptyTitle>{m.energy_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.energy_empty_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
