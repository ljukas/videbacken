import { CHART_HEIGHT } from '~/components/chart/ChartParts'
import { type ChartConfig, ChartContainer } from '~/components/ui/chart'
import { cn } from '~/lib/utils'

// The recharts frame, for the charts not yet on visx (client-perf step 5).
// The library-free parts live in ~/components/chart/ChartParts.
export { CHART_HEIGHT, NoData, TooltipRow } from '~/components/chart/ChartParts'

export function ChartFrame({
  config,
  className,
  children,
}: {
  config: ChartConfig
  /** Merged after the defaults (e.g. a page's own tick/legend sizes). */
  className?: string
  children: React.ReactElement
}) {
  // Inline height (not a Tailwind class) so the chart has a measurable box
  // before CSS loads and in the Tailwind-less browser-test env (same as
  // ClimateChart); width stays responsive.
  return (
    <ChartContainer
      config={config}
      className={cn('aspect-auto w-full', className)}
      style={{ height: CHART_HEIGHT }}
    >
      {children}
    </ChartContainer>
  )
}
