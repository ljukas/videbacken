import { BarChart } from '~/components/chart/BarChart'
import { NoData, TooltipRow } from '~/components/chart/ChartParts'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatSek, monthLabel } from './format'

type Month = RouterOutputs['evCharging']['economy']['months'][number]

// Series colours: each keeps >=3:1 against the card in both themes (--chart-1,
// -4 and -5 fail one theme; see MonthlyChart). Contrast vs card, light / dark:
//   immediate  --muted-foreground  4.7 / 6.7  (the quiet baseline)
//   actual     --chart-3           9.1 / 8.1
//   optimal    --chart-2           3.7 / 7.0
//   stub       muted-foreground @45 %, as /charging's "Pris saknas" stub

// Per month: what charging at once would have cost, what we paid and the
// cheapest schedule — side by side, over the month's comparable sessions only.
// A month with none gets no bars (never 0 kr); if it still had sessions, all
// excluded, it gets a quiet stub saying why instead of looking like a month
// without charging.
const allExcluded = (mo: Month) => mo.sessions > 0 && mo.included === 0

// Why a month's sessions were all left out, in the tooltip.
function stubReason(mo: Month) {
  const { noHourly, noPrice } = mo.excluded
  if (noHourly === 0 && noPrice > 0) return m.charging_chart_no_price()
  if (noPrice === 0 && noHourly > 0) return m.charging_economy_series_no_hourly()
  return m.charging_economy_series_not_comparable()
}

export function EconomyMonthlyChart({ months }: { months: Month[] }) {
  const config = {
    immediate: { label: m.charging_economy_series_immediate(), color: 'var(--muted-foreground)' },
    actual: { label: m.charging_economy_series_actual(), color: 'var(--chart-3)' },
    optimal: { label: m.charging_economy_series_optimal(), color: 'var(--chart-2)' },
    // One legend label true for every reason; the tooltip names the specific one.
    stub: {
      label: m.charging_economy_series_not_comparable(),
      color: 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)',
    },
  }
  // Stubs are honest data: only a year with no sessions at all has nothing to show.
  if (!months.some((mo) => mo.sessions > 0)) return <NoData />
  const hasStub = months.some(allExcluded)
  // The stub is a sliver (3 %) of the axis span, just enough to be seen. With no
  // kronor to scale against (nothing comparable, or all of it 0) the domain is
  // pinned so the stub stays a sliver, and the unlabelled axis and grid go.
  const top = Math.max(
    ...months.map((mo) =>
      mo.included > 0
        ? Math.max(Math.abs(mo.immediateSek), Math.abs(mo.actualSek), Math.abs(mo.optimalSek))
        : 0,
    ),
  )
  const flat = top === 0
  const stub = flat ? 1 : top * 0.03
  const data = months.map((mo) => ({
    label: monthLabel(mo.month),
    stub: allExcluded(mo) ? stub : null,
    reason: allExcluded(mo) ? stubReason(mo) : null,
    sessions: mo.sessions,
    included: mo.included,
    // null (not 0): a month without comparable sessions has no bars, not 0 kr ones.
    immediate: mo.included > 0 ? mo.immediateSek : null,
    actual: mo.included > 0 ? mo.actualSek : null,
    optimal: mo.included > 0 ? mo.optimalSek : null,
  }))
  // Side by side: immediate | actual (its stub stacked in the same slot) | optimal.
  // A real 0 or near-0 kr counterfactual in an included month is data and gets
  // a visible bar; null (excluded month) stays empty.
  const series = [
    { key: 'immediate', ...config.immediate, radius: 3, zeroIsData: true },
    { key: 'actual', ...config.actual, stack: 'mid', radius: 3, zeroIsData: true },
    { key: 'optimal', ...config.optimal, radius: 3, zeroIsData: true },
    // Lists the rendered series, so the stub's legend entry appears only with one.
    ...(hasStub
      ? [{ key: 'stub', ...config.stub, stack: 'mid', radius: 3, zeroIsData: true }]
      : []),
  ]
  return (
    <BarChart
      rows={data}
      category={(r) => r.label}
      series={series}
      value={(r, key) => r[key as 'immediate' | 'actual' | 'optimal' | 'stub']}
      yTickFormat={(v) => formatSek(v)}
      yAxisLine={false}
      hideYAxis={flat}
      yDomain={flat ? [0, stub / 0.03] : undefined}
      barGap={2}
      legend
      label={m.charging_economy_chart_sek_title()}
      tooltip={(r) => {
        // The stub has a label but no kronor value — nothing was compared.
        if (r.stub !== null) {
          return <TooltipRow label={r.reason ?? config.stub.label} color={config.stub.color} />
        }
        if (r.immediate === null || r.actual === null || r.optimal === null) return null
        return (
          <>
            <TooltipRow label={config.immediate.label} color={config.immediate.color}>
              {formatSek(r.immediate)}
            </TooltipRow>
            <TooltipRow label={config.actual.label} color={config.actual.color}>
              {formatSek(r.actual)}
            </TooltipRow>
            <div className="flex w-full flex-col gap-0.5">
              <TooltipRow label={config.optimal.label} color={config.optimal.color}>
                {formatSek(r.optimal)}
              </TooltipRow>
              {r.included < r.sessions ? (
                <span className="text-muted-foreground text-xs">
                  {m.charging_economy_tooltip_compared({
                    included: r.included,
                    sessions: r.sessions,
                  })}
                </span>
              ) : null}
            </div>
          </>
        )
      }}
    />
  )
}
