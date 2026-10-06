import { BarChart } from '~/components/chart/BarChart'
import { NoData, TooltipRow } from '~/components/chart/ChartParts'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatOre, formatOrePrecise, monthLabel } from './format'

type Month = RouterOutputs['evCharging']['economy']['months'][number]

// Series colours keep >=3:1 against the card in both themes (contrast light /
// dark): paid --chart-2 3.7 / 7.0; month average --foreground 19.8 / 15.9,
// dashed so it reads as a reference line rather than a second bar series.

// Spot we paid (energy-weighted, comparable sessions) vs the month's
// time-weighted average spot, both öre/kWh incl VAT. A bar below the line
// means we charged in cheaper-than-average hours.
export function SpotComparisonChart({ months }: { months: Month[] }) {
  const config = {
    paid: { label: m.charging_economy_series_paid(), color: 'var(--chart-2)' },
    avg: { label: m.charging_economy_series_avg(), color: 'var(--foreground)' },
  }
  // No priced session in scope: nothing to compare (an average-only chart would be market data, not ours).
  if (!months.some((mo) => mo.paidSpotOre !== null)) return <NoData />
  const data = months.map((mo) => ({
    label: monthLabel(mo.month),
    paid: mo.paidSpotOre,
    // The average is a reference for what we paid: drawn only where the scope paid something.
    avg: mo.paidSpotOre === null ? null : mo.avgSpotOre,
  }))
  return (
    <BarChart
      rows={data}
      category={(r) => r.label}
      // A real near-zero price (even 0) must not vanish; null draws no bar.
      series={[{ key: 'paid', ...config.paid, radius: 3, zeroIsData: true }]}
      // Dashed, so it reads as a reference line rather than a second bar
      // series; its dots stay solid.
      line={{ key: 'avg', ...config.avg, dash: '5 4' }}
      value={(r, key) => r[key as 'paid' | 'avg']}
      yTickFormat={(v) => formatOre(v)}
      yAxisLine={false}
      legend
      label={m.charging_economy_chart_spot_title()}
      tooltip={(r) =>
        r.paid === null ? null : (
          <>
            <TooltipRow label={config.paid.label} color={config.paid.color}>
              {m.charging_economy_ore({ value: formatOrePrecise(r.paid) })}
            </TooltipRow>
            {r.avg === null ? null : (
              <TooltipRow label={config.avg.label} color={config.avg.color}>
                {m.charging_economy_ore({ value: formatOrePrecise(r.avg) })}
              </TooltipRow>
            )}
          </>
        )
      }
    />
  )
}
