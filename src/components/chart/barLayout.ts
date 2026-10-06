import { range } from 'd3-array'
import { type ScaleBand, type ScaleLinear, scaleLinear } from 'd3-scale'
import { stack, stackOffsetDiverging, stackOffsetNone } from 'd3-shape'

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

/** 'none' stacks each series on the running sum; 'diverging' stacks positives up from 0 and negatives down from 0 (recharts' "sign"). */
export type StackOffset = 'none' | 'diverging'

// [y0, y1] per series key and index; a null value stacks as 0 (it draws nothing).
function stacked(count: number, keys: string[], value: Value, offset: StackOffset = 'none') {
  const layers = stack<number, string>()
    .keys(keys)
    .value((i, key) => value(i, key) ?? 0)
    .offset(offset === 'diverging' ? stackOffsetDiverging : stackOffsetNone)(range(count))
  return new Map(layers.map((layer) => [layer.key, layer.map(([y0, y1]) => [y0, y1] as const)]))
}

export function layoutBars({
  count,
  series,
  value,
  x,
  y,
  barGap,
  offset = 'none',
  minPx = MIN_BAR_PX,
}: {
  count: number
  series: readonly BarSeries[]
  value: Value
  x: ScaleBand<number>
  y: ScaleLinear<number, number>
  barGap: number
  /** How a stack's segments are placed. Default 'none' (on the running sum). */
  offset?: StackOffset
  /** The shortest a bar draws, in px. Default MIN_BAR_PX; 0 draws a tiny value at its true height. */
  minPx?: number
}): BarRect[] {
  const slots = slotsOf(series)
  const band = x.bandwidth()
  const inset = band * CATEGORY_GAP
  // As recharts: a band too narrow for the gaps drops them, and a bar wider
  // than 1 px is a whole number of pixels (any remainder trails in the band).
  const gap = band - 2 * inset - (slots.length - 1) * barGap > 0 ? barGap : 0
  const raw = Math.max(0, (band - 2 * inset - (slots.length - 1) * gap) / slots.length)
  const width = raw > 1 ? Math.trunc(raw) : raw
  const segments = new Map<string, { slot: number; ys: (readonly [number, number])[] }>()
  slots.forEach((keys, slot) => {
    const ys = stacked(count, keys, value, offset)
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
      const height = Math.max(Math.abs(base - end), minPx)
      // A positive (or zero) value grows up from its lower edge; a negative one
      // down from its upper edge (d3 orders a diverging negative's ends the
      // other way round, so go by pixels, not by y0/y1).
      const top = v >= 0 ? Math.max(base, end) - height : Math.min(base, end)
      rects.push({
        key: s.key,
        index: i,
        x: (x(i) ?? 0) + inset + seg.slot * (width + gap),
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
  offset = 'none',
}: {
  count: number
  series: readonly BarSeries[]
  value: Value
  offset?: StackOffset
}): [number, number] {
  let lo = 0
  let hi = 0
  for (const keys of slotsOf(series)) {
    for (const ys of stacked(count, keys, value, offset).values()) {
      for (const [y0, y1] of ys) {
        lo = Math.min(lo, y0, y1)
        hi = Math.max(hi, y0, y1)
      }
    }
  }
  return [lo, hi]
}

const TICK_COUNT = 5

// recharts' getDigitCount: d with 10^(d-1) <= v < 10^d (0.25 has 0, 35 has 2).
function digitCount(v: number): number {
  let d = Math.floor(Math.log10(v)) + 1
  if (10 ** (d - 1) > v) d--
  else if (10 ** d <= v) d++
  return d
}

// recharts' getAdaptiveStep with allowDecimals false: the rough step
// (span / 4) rounded up to a whole number of grains, plus `correction` grains,
// then up to a whole number. A grain is a twentieth of 10^digits, or 1 when
// the rough step has one digit. recharts computes it in decimal.js; here each
// rounded-up value is one product or quotient of the span and a whole number,
// so whole-number data land on the same ceilings.
function adaptiveStep(span: number, digits: number, correction: number): number {
  const intervals = TICK_COUNT - 1
  if (digits <= 0) {
    // A grain under 1: count in its reciprocal.
    const perUnit = 20 * 10 ** -digits
    return Math.ceil((Math.ceil((span * perUnit) / intervals) + correction) / perUnit)
  }
  const grain = digits === 1 ? 1 : 5 * 10 ** (digits - 2)
  return (Math.ceil(span / (intervals * grain)) + correction) * grain
}

/**
 * recharts 3's getNiceTickValues([lo, hi], 5, false), its y axis with
 * allowDecimals={false}, for a range holding 0 (yScaleFor's always does, so 0
 * is a tick). Always TICK_COUNT ticks in whole steps of at least 1: the
 * smallest adaptive step whose ticks cover the range, the spare ticks above 0,
 * or below it when nothing is above (one session draws a quarter-high bar, not
 * a full one).
 */
function integerTicks(lo: number, hi: number): number[] {
  // Flat (both 0): recharts' single-value ticks, which put a 0 at 0 to 4.
  if (lo === hi) return range(TICK_COUNT)
  const span = hi - lo
  const digits = digitCount(span / (TICK_COUNT - 1))
  for (let correction = 0; ; correction++) {
    const step = adaptiveStep(span, digits, correction)
    let below = Math.ceil((0 - lo) / step)
    let above = Math.ceil(hi / step)
    const count = below + above + 1
    if (count > TICK_COUNT) continue
    if (hi > 0) above += TICK_COUNT - count
    else below += TICK_COUNT - count
    return range(-below, above + 1).map((i) => i * step)
  }
}

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
    const ticks = integerTicks(lo, hi)
    const scale = scaleLinear()
      .domain([ticks[0], ticks[ticks.length - 1]])
      .range([height, 0])
    return { scale, ticks }
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
  if (n === 0) return []
  if (n === 1) return [0]
  const left = (i: number) => centres[i] - widths[i] / 2
  const right = (i: number) => centres[i] + widths[i] / 2
  const kept = [0]
  for (let i = 1; i < n - 1; i++) {
    if (left(i) >= right(kept[kept.length - 1]) + gap && right(i) + gap <= left(n - 1)) kept.push(i)
  }
  // The last always shows; the first gives way if the two collide.
  if (kept.length === 1 && right(0) + gap > left(n - 1)) return [n - 1]
  kept.push(n - 1)
  return kept
}

/** Whether every label fits without thinning (no two closer than `gap` px). */
export function labelsFit(centres: readonly number[], widths: readonly number[], gap = 5): boolean {
  return thinTicks(centres, widths, gap).length === centres.length
}
