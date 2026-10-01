import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { ChartFrame, NoData, TooltipRow } from './ChartFrame'
import { formatSek, monthLabel } from './format'

type Month = RouterOutputs['evCharging']['economy']['months'][number]

// Series colours: each keeps >=3:1 against the card in both themes (--chart-1,
// -4 and -5 fail one theme; see MonthlyChart). Contrast vs card, light / dark:
//   immediate  --muted-foreground  4.7 / 6.7  (the quiet baseline)
//   actual     --chart-3           9.1 / 8.1
//   optimal    --chart-2           3.7 / 7.0
//   stub       muted-foreground @45 %, as /charging's "Pris saknas" stub
const SERIES_ORDER = ['immediate', 'actual', 'optimal', 'stub']
const seriesOrder = (item: { dataKey?: unknown }) => SERIES_ORDER.indexOf(String(item.dataKey))

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
  } satisfies ChartConfig
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
  return (
    <ChartFrame config={config}>
      <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }} barGap={2}>
        {flat ? null : <CartesianGrid vertical={false} />}
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        <YAxis
          hide={flat}
          domain={flat ? [0, stub / 0.03] : undefined}
          width="auto"
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          tickFormatter={(v) => formatSek(Number(v))}
        />
        <ChartTooltip
          cursor={false}
          itemSorter={seriesOrder}
          content={
            <ChartTooltipContent
              formatter={(value, name, item) => {
                const series = config[name as keyof typeof config]
                const { reason, included, sessions } = item.payload
                // The stub has a label but no kronor value — nothing was compared.
                if (name === 'stub') {
                  return <TooltipRow label={reason ?? series.label} color={series.color} />
                }
                return (
                  <div className="flex w-full flex-col gap-0.5">
                    <TooltipRow label={series.label} color={series.color}>
                      {formatSek(Number(value))}
                    </TooltipRow>
                    {name === 'optimal' && included < sessions ? (
                      <span className="text-muted-foreground text-xs">
                        {m.charging_economy_tooltip_compared({ included, sessions })}
                      </span>
                    ) : null}
                  </div>
                )
              }}
            />
          }
        />
        <ChartLegend
          itemSorter={seriesOrder}
          content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />}
        />
        <Bar
          dataKey="immediate"
          fill="var(--color-immediate)"
          radius={3}
          isAnimationActive={false}
        />
        <Bar
          dataKey="actual"
          stackId="mid"
          fill="var(--color-actual)"
          radius={3}
          isAnimationActive={false}
        />
        <Bar dataKey="optimal" fill="var(--color-optimal)" radius={3} isAnimationActive={false} />
        {/* Lists the rendered series, so the stub's legend entry appears only with one. */}
        {hasStub ? (
          <Bar
            dataKey="stub"
            stackId="mid"
            fill="var(--color-stub)"
            radius={3}
            isAnimationActive={false}
          />
        ) : null}
      </BarChart>
    </ChartFrame>
  )
}
