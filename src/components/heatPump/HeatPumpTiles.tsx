import { m } from '~/paraglide/messages'
import { formatCelsius, formatChange, formatKwh } from './format'
import type { HeatPumpTiles as Tiles } from './heatPumpView'

// The period's figures (spec "Förbrukning"): kWh per unit with "hittills" on a running period, the change against
// the same period a year earlier (only when both are ≥ 99 % complete), the mean outdoor temperature, and the
// missing-hours note. Every line keeps its height whether or not it has text: changing period moves nothing.
export function HeatPumpTiles({ tiles }: { tiles: Tiles }) {
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        {tiles.units.map((t) => (
          <div
            key={t.id}
            data-heat-pump-tile={t.id}
            className="flex min-w-0 flex-col gap-0.5 rounded-lg border p-3"
          >
            <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{ background: t.color }}
              />
              <span className="truncate">{t.name}</span>
            </dt>
            <dd className="font-semibold text-2xl tabular-nums">
              {t.kwh === null ? '—' : formatKwh(t.kwh)}
              {tiles.running && t.kwh !== null ? (
                <span className="ml-1.5 font-normal text-muted-foreground text-sm">
                  {m.energy_chart_so_far()}
                </span>
              ) : null}
            </dd>
            <dd className="text-muted-foreground text-sm tabular-nums">
              {t.change === null || tiles.comparedWith === null
                ? ' '
                : m.heat_pump_tile_change({
                    change: formatChange(t.change),
                    period: tiles.comparedWith,
                  })}
            </dd>
          </div>
        ))}
        <div
          data-heat-pump-tile="outdoor"
          className="flex min-w-0 flex-col gap-0.5 rounded-lg border p-3"
        >
          <dt className="text-muted-foreground text-sm">{m.heat_pump_tile_outdoor()}</dt>
          <dd className="font-semibold text-2xl tabular-nums">
            {tiles.outdoorC === null ? '—' : formatCelsius(tiles.outdoorC)}
          </dd>
          <dd className="text-muted-foreground text-sm">{m.heat_pump_tile_outdoor_detail()}</dd>
        </div>
      </dl>
      <p data-slot="heat-pump-missing" className="text-muted-foreground text-sm">
        {tiles.missingHours === null
          ? ' '
          : m.energy_missing_hours({ hours: String(tiles.missingHours) })}
      </p>
    </div>
  )
}
