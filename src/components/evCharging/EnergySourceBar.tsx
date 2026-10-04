import { supplySplit } from '~/lib/evCharging/cost'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatOneDecimal } from './format'

type Supply = { kwh: number; solarKwh: number; batteryKwh: number; noHouseDataKwh: number }
type Source = 'grid' | 'solar' | 'battery'

// Own tokens (app.css --energy-*), not the status colours: green/amber mean
// timing verdicts on the same card.
const SOURCES: { key: Source; label: () => string; swatch: string }[] = [
  { key: 'grid', label: m.charging_supply_grid, swatch: 'bg-energy-grid' },
  { key: 'solar', label: m.charging_supply_solar, swatch: 'bg-energy-solar' },
  { key: 'battery', label: m.charging_supply_battery, swatch: 'bg-energy-battery' },
]

/** Float slack for "every kWh lacks house data". */
const ALL_EPSILON_KWH = 1e-6

/** Below this a source would read "0,0 kWh" and draw a sliver: left out. */
const SHOWN_MIN_KWH = 0.05

// Where a session's energy came from (ADR-0023): grid (incl. energy without
// house data, counted as bought), own solar, the home battery (whatever charged
// it). The legend carries every figure in text, so the bar is decoration for
// assistive tech and its colours needn't clear 3:1 on their own. A session with
// no house data at all gets a sentence instead of a 100 % grid bar.
export function EnergySourceBar({ supply }: { supply: Supply }) {
  if (supply.kwh <= 0) return null
  if (supply.noHouseDataKwh >= supply.kwh - ALL_EPSILON_KWH) {
    return <p className="text-muted-foreground text-sm">{m.charging_session_no_house_data_all()}</p>
  }
  const split = supplySplit(supply)
  const kwh: Record<Source, number> = {
    grid: split.gridKwh,
    solar: split.solarKwh,
    battery: split.batteryKwh,
  }
  const shown = SOURCES.filter((s) => kwh[s.key] >= SHOWN_MIN_KWH)
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="font-medium text-muted-foreground text-sm">
        {m.charging_session_sources_title()}
      </figcaption>
      <div aria-hidden="true" className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {shown.map((s) => (
          <span
            key={s.key}
            data-source={s.key}
            // min-w-1: a small share stays visible beside its 1 px seam.
            className={cn('h-full min-w-1 not-last:border-background not-last:border-r', s.swatch)}
            style={{ width: `${(kwh[s.key] / supply.kwh) * 100}%` }}
          />
        ))}
      </div>
      {/* role="list": Safari drops list semantics under list-style: none. */}
      {/* biome-ignore lint/a11y/noRedundantRoles: see above */}
      <ul role="list" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', s.swatch)} />
            <span className="text-muted-foreground">{s.label()}</span>
            <span className="font-medium tabular-nums">{formatOneDecimal(kwh[s.key])} kWh</span>
          </li>
        ))}
      </ul>
      {supply.noHouseDataKwh >= SHOWN_MIN_KWH ? (
        <p className="text-muted-foreground text-xs">
          {m.charging_session_no_house_data({ kwh: formatOneDecimal(supply.noHouseDataKwh) })}
        </p>
      ) : null}
    </figure>
  )
}
