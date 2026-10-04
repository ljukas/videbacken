import { m } from '~/paraglide/messages'

// The economy view measures price timing as if every kWh were bought from the
// grid (ADR-0023 decision 8). Said up front, so its kronor aren't read as what
// charging cost: that's the overview's cash cost.
export function EconomyGridOnlyLead() {
  return (
    <p className="max-w-prose text-pretty text-muted-foreground text-sm">
      <span className="font-medium text-foreground">{m.charging_economy_grid_only_heading()}.</span>{' '}
      {m.charging_economy_grid_only_lead()}
    </p>
  )
}
