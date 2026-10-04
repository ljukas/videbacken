import { supplySplit } from '~/lib/evCharging/cost'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatOneDecimal } from './format'

type Supply = { kwh: number; solarKwh: number; batteryKwh: number; noHouseDataKwh: number }
type Source = 'grid' | 'solar' | 'battery'

const SOURCES: { key: Source; label: () => string; swatch: string }[] = [
  { key: 'grid', label: m.charging_supply_grid, swatch: 'bg-muted-foreground' },
  { key: 'solar', label: m.charging_supply_solar, swatch: 'bg-warning' },
  { key: 'battery', label: m.charging_supply_battery, swatch: 'bg-success' },
]

/** Float slack for "every kWh lacks house data". */
const ALL_EPSILON_KWH = 1e-6

// Where a session's energy came from (ADR-0023): grid (incl. energy without
// house data, counted as bought), own solar, the home battery. One image
// summarised in its label; the legend carries every figure in text, so the
// colours only echo it (they needn't clear 3:1 on their own). A session with
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
  const shown = SOURCES.filter((s) => kwh[s.key] > 0)
  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium text-muted-foreground text-sm">
        {m.charging_session_sources_title()}
      </span>
      <div
        role="img"
        aria-label={m.charging_session_sources_label({
          grid: formatOneDecimal(kwh.grid),
          solar: formatOneDecimal(kwh.solar),
          battery: formatOneDecimal(kwh.battery),
        })}
        className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
      >
        {shown.map((s) => (
          <span
            key={s.key}
            data-source={s.key}
            className={cn('h-full not-last:border-background not-last:border-r', s.swatch)}
            style={{ width: `${(kwh[s.key] / supply.kwh) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', s.swatch)} />
            <span className="text-muted-foreground">{s.label()}</span>
            <span className="font-medium tabular-nums">{formatOneDecimal(kwh[s.key])} kWh</span>
          </li>
        ))}
      </ul>
      {supply.noHouseDataKwh > 0 ? (
        <p className="text-muted-foreground text-xs">
          {m.charging_session_no_house_data({ kwh: formatOneDecimal(supply.noHouseDataKwh) })}
        </p>
      ) : null}
    </div>
  )
}
