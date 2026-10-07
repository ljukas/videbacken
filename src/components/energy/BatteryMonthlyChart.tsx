import { useMemo } from 'react'
import { BarChart, type BarSeries } from '~/components/chart/BarChart'
import { CHART_HEIGHT, HATCH_SWATCH, TooltipRow } from '~/components/chart/ChartParts'
import {
  formatCount,
  formatOneDecimal,
  monthLabel,
  monthName,
} from '~/components/evCharging/format'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { efficiencyText, lossShareText } from './BatteryFlow'
import { type BatteryChartRow, batteryChartRows } from './batteryChart'
import { storedText } from './flowParts'

const monthCategory = (r: BatteryChartRow) => monthLabel(r.month)
const monthInitial = (r: BatteryChartRow) => monthLabel(r.month).charAt(0).toUpperCase()
const seriesValue = (r: BatteryChartRow, key: string) => (key === 'out' ? r.out : r.loss)
const barLabel = (r: BatteryChartRow) => r.label

// The battery per month of `year` (step 2): out with the loss stacked on top, a share label above winter months,
// a legend, a tooltip with in by origin, the change in stored energy, out, the loss and the efficiency. Clicking a
// month (or Enter on the keyboard-focused one) selects it. Months without readings draw no bar.
export function BatteryMonthlyChart({
  year,
  months,
  currentMonth,
  selectedMonth,
  onSelectMonth,
}: {
  year: number
  months: (PeriodSums | null)[]
  /** The current Stockholm month when `year` is the current year (its tooltip says "hittills"), else null. */
  currentMonth: number | null
  /** The month (1–12) of `year` shown in the summary, else null. */
  selectedMonth: number | null
  onSelectMonth: (month: number) => void
}) {
  const series = useMemo<BarSeries[]>(
    () => [
      {
        key: 'out',
        label: m.energy_battery_series_out(),
        color: 'var(--energy-battery)',
        stack: 'kwh',
        stroke: 'var(--card)',
        strokeWidth: 2,
      },
      {
        key: 'loss',
        label: m.energy_battery_series_loss(),
        color: 'var(--energy-loss)',
        stack: 'kwh',
        pattern: 'hatch',
        radius: 2,
        roundEndOnly: true,
        stroke: 'var(--card)',
        strokeWidth: 2,
      },
    ],
    [],
  )
  const rows = useMemo(() => batteryChartRows(months), [months])
  if (months.every((p) => p === null)) {
    return (
      <div>
        <div
          className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
          style={{ height: CHART_HEIGHT }}
        >
          {m.energy_chart_no_data({ year: String(year) })}
        </div>
        <p aria-hidden className="invisible mt-2 text-muted-foreground text-sm">
          {m.energy_battery_chart_hint()}
        </p>
      </div>
    )
  }
  return (
    <div>
      <BarChart
        rows={rows}
        category={monthCategory}
        shortCategory={monthInitial}
        series={series}
        value={seriesValue}
        yTickFormat={formatCount}
        yIntegers
        tickPx={13}
        minBarPx={0}
        legend
        legendClassName="text-sm"
        barLabel={barLabel}
        tooltipTitle={false}
        tooltipClassName="min-w-56 gap-1 border-border px-3 py-2 text-sm [&>div]:gap-1"
        tooltip={(r) =>
          r.sums ? <BatteryTooltip row={r} sums={r.sums} currentMonth={currentMonth} /> : null
        }
        label={m.energy_battery_chart_title({ year: String(year) })}
        keyboardHint={m.energy_chart_keyboard_hint()}
        selection={{
          selected: selectedMonth === null ? null : selectedMonth - 1,
          onSelect: (i) => onSelectMonth(rows[i].month),
          canSelect: (r) => r.sums !== null,
        }}
      />
      <p className="mt-2 text-muted-foreground text-sm">{m.energy_battery_chart_hint()}</p>
    </div>
  )
}

function BatteryTooltip({
  row,
  sums,
  currentMonth,
}: {
  row: BatteryChartRow
  sums: PeriodSums
  currentMonth: number | null
}) {
  const f = energyFigures(sums)
  const gap = gapHours(f)
  const kwh = (v: number) => `${formatOneDecimal(v)} kWh`
  return (
    <>
      <div className="font-semibold text-sm">
        {monthName(row.month)}
        {row.month === currentMonth ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      <TooltipRow label={m.energy_battery_tooltip_in()} strong share="">
        {kwh(f.batteryIn)}
      </TooltipRow>
      <TooltipRow
        label={m.energy_battery_tooltip_from_solar()}
        color="var(--energy-solar)"
        share=""
      >
        {kwh(f.solarToBattery)}
      </TooltipRow>
      <TooltipRow label={m.energy_battery_tooltip_from_grid()} color="var(--energy-grid)" share="">
        {kwh(f.batteryIn - f.solarToBattery)}
      </TooltipRow>
      <TooltipRow label={m.energy_flow_row_stored()} share="">
        {storedText(sums, f)}
      </TooltipRow>
      <TooltipRow
        label={m.energy_battery_series_out()}
        color="var(--energy-battery)"
        strong
        share=""
      >
        {kwh(f.batteryOut)}
      </TooltipRow>
      <TooltipRow
        label={m.energy_battery_series_loss()}
        color={HATCH_SWATCH('var(--energy-loss)')}
        strong
        share={lossShareText(f)}
      >
        {kwh(f.loss)}
      </TooltipRow>
      <TooltipRow label={m.energy_battery_efficiency()} share="">
        {efficiencyText(f.efficiency)}
      </TooltipRow>
      {gap === null ? null : (
        <span className="text-muted-foreground">
          {m.energy_missing_hours({ hours: String(gap) })}
        </span>
      )}
    </>
  )
}
