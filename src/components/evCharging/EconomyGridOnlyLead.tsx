import { Link } from '@tanstack/react-router'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { m } from '~/paraglide/messages'

// The economy view measures price timing as if every kWh were bought from the
// grid (ADR-0023 decision 8). Said up front, so its kronor aren't read as what
// charging cost: that's the overview's cash cost, linked for the same year and
// vehicle scope so the figures compare.
export function EconomyGridOnlyLead({
  year,
  vehicle,
}: {
  year: number
  /** The page's own search value: undefined is every session (a clean URL), as on the overview. */
  vehicle: VehicleScope | undefined
}) {
  return (
    <p className="max-w-2xl text-pretty text-muted-foreground text-sm">
      <span className="font-medium text-foreground">{m.charging_economy_grid_only_heading()}.</span>{' '}
      {m.charging_economy_grid_only_lead()}{' '}
      <Link
        to="/charging"
        search={{ year, vehicle }}
        className="rounded-sm font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {m.charging_economy_grid_only_link()}
      </Link>
      .
    </p>
  )
}
