import { TooltipWithBounds, useTooltip } from '@visx/tooltip'
import type * as React from 'react'

export function useChartPopover<T>() {
  const t = useTooltip<T>()
  return {
    open: t.tooltipOpen,
    data: t.tooltipData,
    left: t.tooltipLeft,
    top: t.tooltipTop,
    show: (data: T, left: number, top: number) =>
      t.showTooltip({ tooltipData: data, tooltipLeft: left, tooltipTop: top }),
    hide: t.hideTooltip,
  }
}

// Positioned relative to the nearest `relative` ancestor (the chart wrapper).
export function ChartPopover({
  state,
  children,
}: {
  state: { open: boolean; left?: number; top?: number }
  children: React.ReactNode
}) {
  if (!state.open) return null
  return (
    <TooltipWithBounds
      unstyled
      applyPositionStyle
      left={state.left}
      top={state.top}
      className="pointer-events-none z-10 rounded-md bg-foreground px-2 py-1 text-background text-xs shadow-md"
    >
      {children}
    </TooltipWithBounds>
  )
}
