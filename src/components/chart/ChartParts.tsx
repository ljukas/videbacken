import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

// The chart parts every chart shares: the height, the empty state, tooltip rows and the legend.

/** One height for every economy/monthly chart and its empty state. */
export const CHART_HEIGHT = 260

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

// One tooltip row: a series row draws its colour dot here (a total row has
// none). `share` adds a smaller,
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

/** The series key under the plot, inside the chart's height (touch can't hover). */
export function ChartLegend({
  items,
  className,
}: {
  items: readonly { key: string; label: string; color: string }[]
  className?: string
}) {
  return (
    <div
      data-slot="chart-legend"
      className={cn('flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3', className)}
    >
      {items.map((item) => (
        <div key={item.key} data-legend-item={item.key} className="flex items-center gap-1.5">
          <div className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
          {item.label}
        </div>
      ))}
    </div>
  )
}
