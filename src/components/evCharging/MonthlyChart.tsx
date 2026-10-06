import { BarChart } from '~/components/chart/BarChart'
import { TooltipRow } from '~/components/chart/ChartParts'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatCount, formatOneDecimal, formatSek, formatShare, monthLabel } from './format'
import type { MetricOption } from './MetricToggle'
import { formatSolarValue, type SolarValueView, solarValueView } from './solarValue'

type Month = RouterOutputs['evCharging']['overview']['months'][number]
type CostMonth = RouterOutputs['evCharging']['costOverview']['months'][number]
export type ChartMetric = 'kwh' | 'sek'

/** The kWh ↔ kr options for `MetricToggle`; the page puts it beside the year picker. */
export function chartMetricOptions(): MetricOption<ChartMetric>[] {
  return [
    { value: 'kwh', label: m.charging_chart_metric_kwh() },
    {
      value: 'sek',
      label: m.charging_chart_metric_sek(),
      ariaLabel: m.charging_chart_metric_sek_label(),
    },
  ]
}

// kWh (or cost) per calendar month of the selected year — always 12 bars (the
// services zero-fill). The kr view is drawn from the cost data alone (its own
// 12 months), so it never pairs one year's kWh with another year's kronor. It
// stacks the spot price under markup + grid + tax, both incl VAT, with a
// legend (touch can't hover) and the month's total in the tooltip. A month
// whose energy has no price at all gets a muted stub labelled "Pris saknas" —
// never an empty bar that reads as 0 kr; a partly priced one says so. The
// tooltip adds the month's value of own solar under its total when there was
// solar (ADR-0023), stub months included. The page owns the metric (its <h2>
// names the chart and follows it); without cost data it's always kWh.
export function MonthlyChart({
  months,
  cost,
  metric = 'kwh',
}: {
  months: Month[]
  /** The cost months and their year (which may lag `months` while a year loads). */
  cost?: { year: number; months: CostMonth[] }
  metric?: ChartMetric
}) {
  const showing: ChartMetric = cost ? metric : 'kwh'
  return showing === 'sek' && cost ? (
    <CostChart months={cost.months} year={cost.year} />
  ) : (
    <EnergyChart months={months} />
  )
}

const kwhSeries = [{ key: 'kwh', label: 'kWh', color: 'var(--chart-1)', radius: 4 }]

function EnergyChart({ months }: { months: Month[] }) {
  const data = months.map((mo) => ({ label: monthLabel(mo.month), kwh: mo.kwh }))
  return (
    <BarChart
      rows={data}
      category={(r) => r.label}
      series={kwhSeries}
      value={(r) => r.kwh}
      yTickFormat={formatCount}
      yIntegers
      label={m.charging_chart_title()}
      tooltip={(r) => (
        <span className="font-medium font-mono text-foreground tabular-nums">
          {formatOneDecimal(r.kwh)} kWh
        </span>
      )}
    />
  )
}

function CostChart({ months, year }: { months: CostMonth[]; year: number }) {
  // Spot and fees in the two chart tokens that keep ≥3:1 against the page in
  // both themes; the unpriced stub is deliberately quiet (the same mixed
  // colour in the bar and its legend swatch).
  const config = {
    spot: { label: m.charging_chart_series_spot(), color: 'var(--chart-2)' },
    fees: { label: m.charging_chart_series_fees(), color: 'var(--chart-3)' },
    unpriced: {
      label: m.charging_chart_no_price(),
      color: 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)',
    },
  }
  // Bought energy with no price; a month of all own solar is a true 0 kr (ADR-0023).
  const unpriced = (c: CostMonth) => c.gridKwh > 0 && c.fullKwh === 0
  // A year with nothing priced has no kronor scale to draw stubs against —
  // they'd be invisible under a 0–4 kr axis and read as 0 kr. Say so instead.
  // A month of all own solar is priced (a true 0 kr), so it draws.
  if (!months.some((c) => c.fullKwh > 0 || (c.kwh > 0 && c.gridKwh === 0))) {
    return (
      <div className="flex h-[260px] items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm">
        {m.charging_chart_cost_empty({ year })}
      </div>
    )
  }
  // The stub is a sliver of the axis span (negative spot prices can push a
  // month below 0), just enough to be seen.
  const stub = Math.max(...months.map((c) => Math.abs(c.totalSek))) * 0.03
  const data = months.map((c) => {
    const missingKwh = c.noPriceKwh + c.noTariffKwh
    return {
      label: monthLabel(c.month),
      // null (not 0) so the tooltip skips a series the month doesn't have.
      spot: unpriced(c) ? null : c.spotSek,
      fees: unpriced(c) ? null : c.feesSek,
      unpriced: unpriced(c) ? stub : null,
      totalSek: c.totalSek,
      // Partly priced, as the tiles say it: "minst …" plus the missing share of the charging.
      missingShare: c.fullKwh > 0 && !c.complete && missingKwh > 0 ? missingKwh / c.kwh : null,
      // The value of own solar used, under the total (ADR-0023); hidden without solar.
      solar: solarValueView(c),
    }
  })
  const hasUnpriced = months.some(unpriced)
  // Segments are separated by a hairline in the page colour, so the split
  // doesn't rely on the two hues alone.
  const seam = { stroke: 'var(--background)', strokeWidth: 1 }
  // Stack order bottom → top, which is also the legend's and the tooltip's.
  // The legend lists the rendered series, so "Pris saknas" appears only with a stub.
  const series = [
    { key: 'spot', ...config.spot, stack: 'sek', ...seam },
    { key: 'fees', ...config.fees, stack: 'sek', radius: 4, roundEndOnly: true, ...seam },
    ...(hasUnpriced
      ? [{ key: 'unpriced', ...config.unpriced, stack: 'sek', radius: 4, roundEndOnly: true }]
      : []),
  ]

  return (
    <BarChart
      rows={data}
      category={(r) => r.label}
      series={series}
      value={(r, key) => r[key as 'spot' | 'fees' | 'unpriced']}
      yTickFormat={formatCount}
      yIntegers
      legend
      label={m.charging_chart_title_cost()}
      tooltip={(r) => {
        if (r.unpriced !== null) {
          return (
            <div className="flex w-full flex-col gap-0.5">
              <TooltipRow label={config.unpriced.label} color={config.unpriced.color} />
              <SolarTooltipRows view={r.solar} />
            </div>
          )
        }
        if (r.spot === null || r.fees === null) return null
        const total = formatSek(r.totalSek)
        return (
          <>
            <TooltipRow label={config.spot.label} color={config.spot.color}>
              {formatSek(r.spot)}
            </TooltipRow>
            <div className="flex w-full flex-col gap-0.5">
              <TooltipRow label={config.fees.label} color={config.fees.color}>
                {formatSek(r.fees)}
              </TooltipRow>
              <TooltipRow label={m.charging_chart_total()} strong>
                {r.missingShare === null ? total : m.charging_cost_min({ total })}
              </TooltipRow>
              {r.missingShare === null ? null : (
                <span className="text-muted-foreground text-xs">
                  {m.charging_cost_partial_hint({ share: formatShare(r.missingShare) })}
                </span>
              )}
              <SolarTooltipRows view={r.solar} />
            </div>
          </>
        )
      }}
    />
  )
}

// The month's value of own solar as tooltip rows: a label/value row and a
// hint beneath it (a separate figure from the total, so no swatch). The hint
// says what the value means, or why it's unknown: the tooltip ignores the
// pointer, so a dash's title could never show its reason.
function SolarTooltipRows({ view }: { view: SolarValueView }) {
  if (view.kind === 'hidden') return null
  const unknown = view.kind === 'unknown'
  return (
    <div className="mt-1 flex flex-col gap-0.5 border-t pt-1">
      <TooltipRow label={m.charging_solar_value_label()}>
        {unknown ? <span aria-hidden="true">—</span> : formatSolarValue(view)}
      </TooltipRow>
      <span className="text-pretty text-muted-foreground text-xs">
        {unknown ? m.charging_solar_value_unknown_hint() : m.charging_solar_value_hint()}
      </span>
    </div>
  )
}
