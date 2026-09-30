import { TooltipWithBounds, useTooltip } from '@visx/tooltip'
import type * as React from 'react'
import { useCallback, useMemo } from 'react'

export function useChartPopover<T>() {
  const { tooltipOpen, tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<T>()
  // Stable callbacks: the heatmap's 168 cells close over `show`/`hide`.
  const show = useCallback(
    (data: T, left: number, top: number) =>
      showTooltip({ tooltipData: data, tooltipLeft: left, tooltipTop: top }),
    [showTooltip],
  )
  const hide = useCallback(() => hideTooltip(), [hideTooltip])
  return useMemo(
    () => ({
      open: tooltipOpen,
      data: tooltipData,
      left: tooltipLeft,
      top: tooltipTop,
      show,
      hide,
    }),
    [tooltipOpen, tooltipData, tooltipLeft, tooltipTop, show, hide],
  )
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
