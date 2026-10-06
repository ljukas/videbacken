import { range, tickStep } from 'd3-array'
import { type ScaleBand, type ScaleLinear, scaleLinear } from 'd3-scale'
import { stack, stackOffsetNone } from 'd3-shape'

// Pure geometry for the bar-chart module (BarChart.tsx). It reproduces what
// recharts 3 did for our charts, so the move to visx keeps the bars where
// they were: 10 % of each band either side, slots split by the bar gap,
// stacked series on top of each other in series order, and a 4 px floor.

/** A real but tiny value still draws this tall, so it doesn't read as "nothing". */
export const MIN_BAR_PX = 4
/** recharts' barCategoryGap: 10 % of a band on each side. */
const CATEGORY_GAP = 0.1

export type BarSeries = {
  key: string
  label: string
  color: string
  /** Series with the same stack id draw as one bar, stacked in series order; others sit side by side. */
  stack?: string
  radius?: number
  /** Round only the end away from the axis (a stack's top). Default: every corner. */
  roundEndOnly?: boolean
  /** A real 0 is data and gets the floor (a 0 kr counterfactual). Default: 0 draws nothing. */
  zeroIsData?: boolean
  /** A hairline round each bar, e.g. the seam between stacked segments. */
  stroke?: string
  strokeWidth?: number
}

export type BarRect = {
  key: string
  index: number
  x: number
  y: number
  width: number
  height: number
  value: number
}

type Value = (index: number, key: string) => number | null

/** The band's slots: one per stack id or unstacked series, in first-seen order. */
export function slotsOf(series: readonly BarSeries[]): string[][] {
  const slots = new Map<string, string[]>()
  for (const s of series) {
    const id = s.stack === undefined ? `series:${s.key}` : `stack:${s.stack}`
    slots.set(id, [...(slots.get(id) ?? []), s.key])
  }
  return [...slots.values()]
}

// [y0, y1] per series key and index; a null value stacks as 0 (it draws nothing).
function stacked(count: number, keys: string[], value: Value) {
  const layers = stack<number, string>()
    .keys(keys)
    .value((i, key) => value(i, key) ?? 0)
    .offset(stackOffsetNone)(range(count))
  return new Map(layers.map((layer) => [layer.key, layer.map(([y0, y1]) => [y0, y1] as const)]))
}

export function layoutBars({
  count,
  series,
  value,
  x,
  y,
  barGap,
}: {
  count: number
  series: readonly BarSeries[]
  value: Value
  x: ScaleBand<number>
  y: ScaleLinear<number, number>
  barGap: number
}): BarRect[] {
  const slots = slotsOf(series)
  const band = x.bandwidth()
  const offset = band * CATEGORY_GAP
  const width = Math.max(0, (band - 2 * offset - (slots.length - 1) * barGap) / slots.length)
  const segments = new Map<string, { slot: number; ys: (readonly [number, number])[] }>()
  slots.forEach((keys, slot) => {
    const ys = stacked(count, keys, value)
    for (const key of keys) segments.set(key, { slot, ys: ys.get(key) ?? [] })
  })
  const rects: BarRect[] = []
  for (const s of series) {
    const seg = segments.get(s.key)
    if (!seg) continue
    for (let i = 0; i < count; i++) {
      const v = value(i, s.key)
      if (v === null || (v === 0 && !s.zeroIsData)) continue
      const [y0, y1] = seg.ys[i]
      const base = y(y0)
      const end = y(y1)
      const height = Math.max(Math.abs(base - end), MIN_BAR_PX)
      // A positive (or zero) value grows up from its base; a negative one down.
      const top = v >= 0 ? base - height : base
      rects.push({
        key: s.key,
        index: i,
        x: (x(i) ?? 0) + offset + seg.slot * (width + barGap),
        y: top,
        width,
        height,
        value: v,
      })
    }
  }
  return rects
}

/** The value range the bars cover: every stack's lowest and highest point, and 0. */
export function stackExtent({
  count,
  series,
  value,
}: {
  count: number
  series: readonly BarSeries[]
  value: Value
}): [number, number] {
  let lo = 0
  let hi = 0
  for (const keys of slotsOf(series)) {
    for (const ys of stacked(count, keys, value).values()) {
      for (const [y0, y1] of ys) {
        lo = Math.min(lo, y0, y1)
        hi = Math.max(hi, y0, y1)
      }
    }
  }
  return [lo, hi]
}

const TICK_COUNT = 5

/** A top-down linear y scale over `extent` (0 included), made nice, and its ticks. */
export function yScaleFor({
  extent,
  height,
  integers = false,
  domain,
}: {
  extent: readonly [number, number]
  height: number
  integers?: boolean
  domain?: readonly [number, number]
}): { scale: ScaleLinear<number, number>; ticks: number[] } {
  const lo = Math.min(0, extent[0])
  const hi = Math.max(0, extent[1])
  if (domain) {
    const scale = scaleLinear().domain([domain[0], domain[1]]).range([height, 0])
    return { scale, ticks: scale.ticks(TICK_COUNT) }
  }
  if (integers) {
    // recharts' allowDecimals={false}: whole steps, at least 1.
    const step = Math.max(1, tickStep(lo, hi === lo ? lo + 1 : hi, TICK_COUNT - 1))
    const d0 = Math.floor(lo / step) * step
    const d1 = Math.max(Math.ceil(hi / step) * step, d0 + step)
    const scale = scaleLinear().domain([d0, d1]).range([height, 0])
    return { scale, ticks: range(d0, d1 + step / 2, step) }
  }
  const scale = scaleLinear()
    .domain([lo, hi === lo ? lo + 1 : hi])
    .range([height, 0])
    .nice(TICK_COUNT)
  return { scale, ticks: scale.ticks(TICK_COUNT) }
}

/**
 * The tick indexes to label so no two labels come closer than `gap` px
 * (recharts' interval="preserveStartEnd"): the first and the last always,
 * the ones between greedily from the start.
 */
export function thinTicks(
  centres: readonly number[],
  widths: readonly number[],
  gap = 5,
): number[] {
  const n = centres.length
  if (n <= 2) return range(n)
  const left = (i: number) => centres[i] - widths[i] / 2
  const right = (i: number) => centres[i] + widths[i] / 2
  const kept = [0]
  for (let i = 1; i < n - 1; i++) {
    if (left(i) >= right(kept[kept.length - 1]) + gap && right(i) + gap <= left(n - 1)) kept.push(i)
  }
  kept.push(n - 1)
  return kept
}
