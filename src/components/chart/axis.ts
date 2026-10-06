import { getStringWidth } from '@visx/text'
import { max } from 'd3-array'

// The axis look the visx charts share (BarChart, ClimateChart): recharts 3's
// defaults, so the move to visx kept the axes where they were.

export const CHART_MARGIN = { top: 8, right: 12, bottom: 0, left: 4 } as const
/** The x axis' band under the plot: tick, margin and one 12–13 px label line. */
export const X_AXIS_H = 30
// recharts' tick size: labels keep their distance from the axis even with the
// tick lines hidden (visx places labels at tickLength too).
export const TICK_SIZE = 6
export const X_TICK_MARGIN = 8
export const Y_TICK_MARGIN = 4
export const TICK_PX = 12
/** recharts' default axis colour; our ChartContainer never restyled it. */
export const AXIS_COLOR = '#666'

/** A label's width in px at `px` font size (an estimate where nothing can measure, as in SSR). */
export const measureAt = (px: number) => (s: string) =>
  getStringWidth(s, { fontSize: px }) ?? s.length * px * 0.6

/** The y axis' width for these labels, its tick and margin included (recharts' width="auto"). */
export const yAxisWidth = (labels: readonly string[], measure: (s: string) => number) =>
  (max(labels, measure) ?? 0) + TICK_SIZE + Y_TICK_MARGIN + 2
