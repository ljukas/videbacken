import { type ChartConfig, ChartContainer } from '~/components/ui/chart'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

/** One height for every economy/monthly chart and its empty state. */
export const CHART_HEIGHT = 260

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

/** The chart-sized "nothing to compare" state. */
export function NoData() {
  return (
    <div
      className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
      style={{ height: CHART_HEIGHT }}
    >
      {m.charging_economy_chart_no_data()}
    </div>
  )
}

// A custom formatter replaces the tooltip's own colour dots, so each series
// row draws its dot here (a total row has none). `share` adds a smaller,
// muted column after the value (omitted: no column).
export function TooltipRow({
  label,
  color,
  strong = false,
  share,
  children,
}: {
  label: string
  color?: string
  strong?: boolean
  share?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {color ? (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-[2px]"
            style={{ background: color }}
          />
        ) : null}
        {label}
      </span>
      <span
        className={`ml-auto font-mono text-foreground tabular-nums ${strong ? 'font-semibold' : 'font-medium'}`}
      >
        {children}
      </span>
      {share === undefined ? null : (
        <span className="w-10 text-right text-[13px] text-muted-foreground tabular-nums">
          {share}
        </span>
      )}
    </div>
  )
}
