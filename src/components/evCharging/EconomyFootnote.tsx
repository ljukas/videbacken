import { m } from '~/paraglide/messages'
import { PriceFootnote } from './PriceFootnote'

// What the economy figures mean and what they leave out (spec decisions 8–10),
// then the elpris attribution. `excluded` lists sessions left out, by reason.
export function EconomyFootnote({
  excluded,
  bucketing = true,
}: {
  excluded: { noHourly: number; noPrice: number }
  /** The month-bucketing sentence; omit it where no monthly totals are shown. */
  bucketing?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs">
      <p>{m.charging_economy_caveat()}</p>
      {bucketing ? <p>{m.charging_economy_bucketing()}</p> : null}
      {excluded.noHourly > 0 ? (
        <p>{m.charging_economy_excluded_no_hourly({ count: excluded.noHourly })}</p>
      ) : null}
      {excluded.noPrice > 0 ? (
        <p>{m.charging_economy_excluded_no_price({ count: excluded.noPrice })}</p>
      ) : null}
      <PriceFootnote />
    </div>
  )
}
