// Client-safe, pure (heat pumps step 2, ADR-0027). The Användning flow diagram's geometry: the period's load (one node)
// split into its consumers (laddning, each heat pump, övrigt hus). Wide: the load on the left, the consumers in a
// column on the right. Narrow: the load across the top, the consumers in a column below, the arrows down an 88 px lane
// on the left. The arrows leave the load side by side, each as wide as its kWh (Sankey-like), so they never overlap
// at the source and never cross. Built on step 1c's primitives; the box height is fixed for up to five consumers so
// the card never changes size with the period.
import type { EnergyFigures } from './figures'
import {
  ARROW_LENGTH,
  FIGURE_MIN_SIZE,
  type FlowEdgeSpec,
  type FlowGraph,
  type FlowNode,
  flowEdge,
  flowWidth,
  MIN_FLOW_KWH,
  NODE_PADDING,
  type NodeText,
  WIDE_MIN_WIDTH,
} from './flowLayout'

export type UseConsumerKey = 'car' | 'house' | `hp:${string}`
export type UseNodeKey = 'load' | UseConsumerKey
export type UseConsumer = { key: UseConsumerKey; kwh: number }
export type UseFlow = { spec: FlowEdgeSpec<UseNodeKey>; kwh: number; width: number }
export type UseFlowLayout = FlowGraph<UseNodeKey> & {
  /** The drawn arrows (from MIN_FLOW_KWH), in consumer order, with their kWh and stroke width. */
  flows: UseFlow[]
}

export const USE_WIDE_HEIGHT = 312
export const USE_NARROW_HEIGHT = 436
/** Narrow: the strip left of the consumer column that the arrows run down. */
export const USE_LANE = 88
/** Arrows leave the load this far apart. */
const PORT_GAP = 2
/** Narrow: room an arrow needs to turn from down to right before its arrowhead. */
const TURN = 24
/** Narrow: where the first arrow may leave the load's bottom edge. */
const LANE_START = 11

export function usageConsumers(f: EnergyFigures): UseConsumer[] {
  return [
    { key: 'car', kwh: f.car },
    ...f.heatPumps.map((u) => ({ key: `hp:${u.id}` as const, kwh: u.kwh })),
    { key: 'house', kwh: f.restOfHouse },
  ]
}

/**
 * Centres for `widths` laid side by side PORT_GAP apart and centred in [0, room]. When they don't fit (several
 * consumers near the largest), the centres are spread evenly and the arrows overlap a little at the source.
 */
export function stackPorts(widths: readonly number[], room: number): number[] {
  const n = widths.length
  if (n === 0) return []
  const total = widths.reduce((sum, w) => sum + w, 0) + PORT_GAP * (n - 1)
  if (total <= room) {
    let at = (room - total) / 2
    return widths.map((w) => {
      const centre = at + w / 2
      at += w + PORT_GAP
      return centre
    })
  }
  if (n === 1) return [room / 2]
  const first = widths[0] / 2
  const step = (room - first - widths[n - 1] / 2) / (n - 1)
  return widths.map((_, i) => first + i * step)
}

export function usageFlowLayout(width: number, consumers: readonly UseConsumer[]): UseFlowLayout {
  const narrow = width < WIDE_MIN_WIDTH
  const n = Math.max(1, consumers.length)
  const drawn = consumers.filter((c) => c.kwh >= MIN_FLOW_KWH)
  const max = Math.max(0, ...drawn.map((c) => c.kwh))
  const widths = drawn.map((c) => flowWidth(c.kwh, max, narrow))
  const nodes = {} as Record<UseNodeKey, FlowNode>
  let flows: UseFlow[]
  if (!narrow) {
    const H = USE_WIDE_HEIGHT
    const load: FlowNode = { x: 236 / 2 + 1, y: H / 2, w: 236, h: 124 }
    nodes.load = load
    // Five consumers fill the box exactly (5 × 52 + 4 × 12 = 308); fewer are centred on the load.
    const pitch = Math.min(64, (H - 4 + 12) / n)
    const h = pitch - 12
    const top = (H - (consumers.length * pitch - 12)) / 2
    consumers.forEach((c, i) => {
      nodes[c.key] = { x: width - 280 / 2 - 1, y: top + h / 2 + i * pitch, w: 280, h }
    })
    // The arrows leave the load's right side top to bottom in consumer order.
    const room = load.h - 24
    const centres = stackPorts(widths, room)
    flows = drawn.map((c, i) => ({
      spec: flowEdge<UseNodeKey>('load', c.key, 'r', centres[i] - room / 2, 'l', 0, 0.5, 0.5, 0.65),
      kwh: c.kwh,
      width: widths[i],
    }))
  } else {
    const H = USE_NARROW_HEIGHT
    const load: FlowNode = { x: width / 2, y: 33, w: width - 2, h: 64 }
    nodes.load = load
    const top = load.h + 1 + 28
    const pitch = Math.min(66, (H - top - 2 + 10) / n)
    const h = pitch - 10
    const w = width - USE_LANE - 2
    consumers.forEach((c, i) => {
      nodes[c.key] = { x: 1 + USE_LANE + w / 2, y: top + h / 2 + i * pitch, w, h }
    })
    // The arrows leave the load's bottom inside the lane, the lowest consumer's outermost (left): each turns right
    // into its node below the ones above it, so none crosses another. Down first, then a late turn (k1 1, k2 0).
    const room = USE_LANE - ARROW_LENGTH - TURN - LANE_START // 44 px, from x = 11
    const centres = stackPorts([...widths].reverse(), room).reverse()
    flows = drawn.map((c, i) => ({
      spec: flowEdge<UseNodeKey>(
        'load',
        c.key,
        'b',
        LANE_START + centres[i] - load.x,
        'l',
        0,
        1,
        0,
      ),
      kwh: c.kwh,
      width: widths[i],
    }))
  }
  return {
    narrow,
    height: narrow ? USE_NARROW_HEIGHT : USE_WIDE_HEIGHT,
    nodes,
    edges: flows.map((f) => f.spec),
    flows,
  }
}

/**
 * Where a node's tile and text go. The load: wide, step 1c's big tile with the label and the figure beside it;
 * narrow, a small tile with the two rows beside it. A consumer: a small tile, the name on the first row and
 * "kWh · share" on the second (the figure steps down from 16 px to fit).
 */
export function usageNodeText(node: FlowNode, key: UseNodeKey, narrow: boolean): NodeText {
  const x0 = node.x - node.w / 2
  const y0 = node.y - node.h / 2
  const value = (x: number, y: number, size: number, minSize: number) => ({
    x,
    y,
    size,
    minSize,
    room: x0 + node.w - NODE_PADDING - x,
  })
  if (key === 'load') {
    if (narrow) {
      const tile = { x: x0 + 12, y: y0 + 15, size: 34, icon: 20 }
      return {
        tile,
        label: { x: x0 + 56, y: y0 + 28 },
        value: value(x0 + 56, y0 + 52, 20, 16),
        second: null,
        third: null,
      }
    }
    const tile = { x: x0 + 12, y: node.y - 24, size: 48, icon: 28 }
    return {
      tile,
      label: { x: x0 + 72, y: node.y - 6 },
      value: value(x0 + 72, node.y + 24, 28, FIGURE_MIN_SIZE),
      second: null,
      third: null,
    }
  }
  const tile = { x: x0 + 10, y: node.y - 16, size: 32, icon: 18 }
  return {
    tile,
    label: { x: x0 + 52, y: node.y - 4 },
    value: value(x0 + 52, node.y + 16, 16, 13),
    second: null,
    third: null,
  }
}
