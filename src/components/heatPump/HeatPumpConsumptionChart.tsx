import { useCallback, useMemo } from 'react'
import {
  BarChart,
  type BarMarker,
  type BarSeries,
  type LineSeries,
} from '~/components/chart/BarChart'
import { CHART_HEIGHT, TooltipRow } from '~/components/chart/ChartParts'
import { formatCount } from '~/components/evCharging/format'
import { type DayEventMarker, dayEventMarkers, type HeatPumpEventDto } from '~/lib/heatPump/events'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatCelsius, formatCelsiusTick, formatKwhOneDecimal } from './format'
import { HeatPumpEventLines } from './HeatPumpEventLines'
import {
  type HeatPumpChartRow,
  type HeatPumpView,
  LAST_YEAR_KEY,
  OUTDOOR_KEY,
} from './heatPumpView'

/** Last year's outline: the muted foreground, a little transparent (it is context, not the data). */
export const LAST_YEAR_COLOR = 'color-mix(in oklab, var(--muted-foreground) 75%, transparent)'

// BarChart's accessors at module level: a stable identity keeps its geometry memo across re-renders.
const rowLabel = (r: HeatPumpChartRow) => r.label
const rowShort = (r: HeatPumpChartRow) => r.short
const rowValue = (r: HeatPumpChartRow, key: string) =>
  key === LAST_YEAR_KEY ? r.lastYear : key === OUTDOOR_KEY ? r.outdoorC : (r.kwh[key] ?? null)
const kwhText = (v: number | null | undefined) => (v == null ? '—' : formatKwhOneDecimal(v))
// The `events` default: one array, so the marker memo below keeps its identity across renders.
const NO_EVENTS: readonly HeatPumpEventDto[] = []
const NO_MARKERS = new Map<string, DayEventMarker[]>()

// The Förbrukning chart (spec "Energi › Värmepumpar"): the units stacked (step 2's colours, name order), last year
// as an outline beside each month (year view), the hour-weighted outdoor temperature as a line on a right-hand
// °C axis. A month bar (year view, Totalt) selects that month; the day chart selects nothing. The day chart marks
// the logged events (step 4a): a ▼ above the day's stack per unit, in its colour, and an event for every unit
// across the column too.
export function HeatPumpConsumptionChart({
  view,
  onSelectMonth,
  events = NO_EVENTS,
}: {
  view: HeatPumpView
  onSelectMonth: (month: { year: number; month: number }) => void
  /** Every logged event (newest first); only the day view draws them. */
  events?: readonly HeatPumpEventDto[]
}) {
  const { units, kind } = view
  const lastYear = kind === 'year' && view.year !== null ? view.year - 1 : null
  const series = useMemo<BarSeries[]>(
    () => [
      ...units.map((u, i) => ({
        key: u.id,
        label: u.name,
        color: heatPumpColor(units, u.id),
        stack: 'kwh',
        stroke: 'var(--card)',
        strokeWidth: 2,
        ...(i === units.length - 1 ? { radius: 2, roundEndOnly: true } : {}),
      })),
      ...(lastYear === null
        ? []
        : [
            {
              key: LAST_YEAR_KEY,
              label: m.heat_pump_series_last_year({ year: String(lastYear) }),
              color: LAST_YEAR_COLOR,
              outline: true,
              strokeWidth: 1.5,
              radius: 2,
              roundEndOnly: true,
            },
          ]),
    ],
    [units, lastYear],
  )
  const line = useMemo<LineSeries>(
    () => ({
      key: OUTDOOR_KEY,
      label: m.heat_pump_series_outdoor(),
      color: 'var(--muted-foreground)',
      axis: 'right',
      tickFormat: formatCelsiusTick,
      strokeWidth: 1.5,
    }),
    [],
  )
  // Events by Stockholm day (string keys: DST- and timezone-proof), only in the day view, where a row's key is its
  // day. One marker per unit per day; colours as the bars'.
  const markerMap = useMemo(
    () =>
      kind === 'month'
        ? dayEventMarkers(
            events,
            units.map((u) => u.id),
          )
        : NO_MARKERS,
    [kind, events, units],
  )
  const markers = useCallback(
    (row: HeatPumpChartRow): BarMarker[] =>
      (markerMap.get(row.key) ?? []).map((mk) =>
        mk.heatPumpId === null
          ? { key: 'all', color: 'var(--foreground)' }
          : {
              key: mk.heatPumpId,
              seriesKey: mk.heatPumpId,
              color: heatPumpColor(units, mk.heatPumpId),
            },
      ),
    [markerMap, units],
  )
  // No outdoor value in any row: no line, so no right axis (an empty one would read 0°–1°).
  const hasOutdoor = view.rows.some((r) => r.outdoorC !== null)
  const selectable = kind !== 'month'
  const hint = (
    <p
      data-slot="heat-pump-chart-hint"
      aria-hidden={selectable ? undefined : true}
      className={cn('mt-2 text-muted-foreground text-sm', !selectable && 'invisible')}
    >
      {m.heat_pump_chart_hint()}
    </p>
  )
  if (view.rows.every((r) => r.total === null && r.lastYear === null)) {
    return (
      <div>
        <div
          className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
          style={{ height: CHART_HEIGHT }}
        >
          {m.heat_pump_chart_no_data({ period: view.periodLabel })}
        </div>
        {hint}
      </div>
    )
  }
  return (
    <div>
      <BarChart
        rows={view.rows}
        category={rowLabel}
        shortCategory={kind === 'year' ? rowShort : undefined}
        series={series}
        line={hasOutdoor ? line : undefined}
        value={rowValue}
        yTickFormat={formatCount}
        yIntegers
        tickPx={13}
        minBarPx={0}
        legend
        legendClassName="text-sm"
        tooltipTitle={false}
        tooltipClassName="min-w-56 gap-1 border-border px-3 py-2 text-sm [&>div]:gap-1"
        tooltip={(r) => {
          const lines = markerMap.get(r.key)
          // A day without readings (yet) still explains its event.
          if (r.total === null && r.lastYear === null && r.outdoorC === null) {
            return lines ? <HeatPumpEventLines markers={lines} units={units} /> : null
          }
          return (
            <>
              <HeatPumpTooltip row={r} view={view} lastYear={lastYear} />
              <HeatPumpEventLines markers={lines} units={units} />
            </>
          )
        }}
        // Passed in the whole day view, events or not, so the space above the stacks doesn't jump when they load.
        markers={kind === 'month' ? markers : undefined}
        label={view.chartLabel}
        keyboardHint={selectable ? m.energy_chart_keyboard_hint() : undefined}
        selection={
          selectable
            ? {
                selected: null,
                onSelect: (i) => {
                  const month = view.rows[i]?.month
                  if (month) onSelectMonth(month)
                },
                canSelect: (r) => r.selectable,
              }
            : undefined
        }
      />
      {hint}
    </div>
  )
}

function HeatPumpTooltip({
  row,
  view,
  lastYear,
}: {
  row: HeatPumpChartRow
  view: HeatPumpView
  lastYear: number | null
}) {
  return (
    <>
      <div className="font-semibold text-sm">
        {row.title}
        {row.running ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      {view.units.map((u) => (
        <TooltipRow key={u.id} label={u.name} color={heatPumpColor(view.units, u.id)}>
          {kwhText(row.kwh[u.id])}
        </TooltipRow>
      ))}
      <TooltipRow label={m.heat_pump_tooltip_total()} strong>
        {kwhText(row.total)}
      </TooltipRow>
      {lastYear === null ? null : (
        <TooltipRow
          label={m.heat_pump_series_last_year({ year: String(lastYear) })}
          color={LAST_YEAR_COLOR}
          outline
        >
          {kwhText(row.lastYear)}
        </TooltipRow>
      )}
      <TooltipRow label={m.heat_pump_tile_outdoor()}>
        {row.outdoorC === null ? '—' : formatCelsius(row.outdoorC)}
      </TooltipRow>
      {row.missingHours >= 1 ? (
        <span className="text-muted-foreground">
          {m.energy_missing_hours({ hours: String(Math.round(row.missingHours)) })}
        </span>
      ) : null}
    </>
  )
}
