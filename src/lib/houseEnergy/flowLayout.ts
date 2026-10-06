// Client-safe, pure (step 1c, ADR-0024). The Summering flow diagram's geometry for a given width: where the five
// nodes sit, which arrows join them, the cubic each arrow draws, arrow widths, the battery's loss stub and where a
// node's text goes. Numbers from the approved mockup (spec "Geometry"); the component only draws them.
import type { EnergyFigures } from './figures'

export type FlowNodeKey = 'sol' | 'imp' | 'bat' | 'exp' | 'load'
export type Side = 'l' | 'r' | 't' | 'b'
/** Centre and size. */
export type FlowNode = { x: number; y: number; w: number; h: number }
export type FlowEdgeSpec<K extends string = FlowNodeKey> = {
  from: K
  to: K
  fromSide: Side
  fromOffset: number
  toSide: Side
  toOffset: number
  /** How far each end keeps its side's direction, as a share of the distance along that axis. */
  k1: number
  k2: number
  /** Where on the curve the value pill sits. */
  labelT: number
}
export type FlowGraph<K extends string> = {
  narrow: boolean
  height: number
  nodes: Record<K, FlowNode>
  edges: FlowEdgeSpec<K>[]
}
export type FlowLayout = FlowGraph<FlowNodeKey> & {
  loss: { side: 'b' | 'r'; offset: number; length: number }
}
type Point = { x: number; y: number }
type Port = Point & { dx: number; dy: number }

/** From this card content width the in → out layout runs left to right; below it, top to bottom. */
export const WIDE_MIN_WIDTH = 860
export const WIDE_HEIGHT = 360
export const NARROW_HEIGHT = 490
/** Below this an arrow would read "0,0": not drawn. */
export const MIN_FLOW_KWH = 0.05
/** Below this (or negative) the loss reads "≈ 0" and has no stub (house energy design, display rules). */
export const MIN_LOSS_KWH = 0.5
const ARROW_LENGTH = 9
/** A node's inner margin: its text starts this far in and may run to this far from the right edge. */
export const NODE_PADDING = 12
/** Smallest sizes a node figure / the battery's loss figure steps down to so it fits its node. */
export const FIGURE_MIN_SIZE = 18
export const LOSS_MIN_SIZE = 16

export const flowEdge = <K extends string>(
  from: K,
  to: K,
  fromSide: Side,
  fromOffset: number,
  toSide: Side,
  toOffset: number,
  k1 = 0.5,
  k2 = 0.5,
  labelT = 0.5,
): FlowEdgeSpec<K> => ({ from, to, fromSide, fromOffset, toSide, toOffset, k1, k2, labelT })

export function flowLayout(width: number): FlowLayout {
  if (width >= WIDE_MIN_WIDTH) {
    const nw = 236
    const h = 80
    const hLoad = 124
    const H = WIDE_HEIGHT
    const L = nw / 2 + 1
    const R = width - nw / 2 - 1
    return {
      narrow: false,
      height: H,
      nodes: {
        sol: { x: L, y: 46, w: nw, h },
        imp: { x: L, y: H - 46, w: nw, h },
        bat: { x: width / 2, y: H / 2 - 10, w: nw, h: 84 },
        exp: { x: R, y: 46, w: nw, h },
        load: { x: R, y: H - hLoad / 2 - 2, w: nw, h: hLoad },
      },
      edges: [
        flowEdge('sol', 'exp', 'r', -22, 'l', 0),
        flowEdge('sol', 'load', 'r', -2, 't', -20),
        flowEdge('sol', 'bat', 'r', 20, 't', -26),
        flowEdge('imp', 'bat', 'r', -20, 'b', -26),
        flowEdge('imp', 'load', 'r', 14, 'l', 30),
        flowEdge('bat', 'load', 'r', 0, 'l', -14),
        flowEdge('bat', 'exp', 't', 26, 'b', -30),
      ],
      loss: { side: 'b', offset: 40, length: 44 },
    }
  }
  const nw = Math.min(220, Math.floor((width - 24) / 2))
  const h = 82
  const hLoad = 134
  const H = NARROW_HEIGHT
  // Offsets were tuned at a 146 px node; they scale with it so a tablet-wide card keeps the arrows apart.
  const k = nw / 146
  const L = nw / 2 + 1
  const R = width - nw / 2 - 1
  return {
    narrow: true,
    height: H,
    nodes: {
      sol: { x: L, y: 43, w: nw, h },
      imp: { x: R, y: 43, w: nw, h },
      bat: { x: width / 2 + 14 * k, y: 226, w: Math.min(190, nw + 4), h: 82 },
      exp: { x: L, y: H - 43, w: nw, h },
      load: { x: R, y: H - hLoad / 2 - 2, w: nw, h: hLoad },
    },
    edges: [
      flowEdge('sol', 'exp', 'b', -50 * k, 't', -50 * k),
      // Runs straight down the battery's left side and turns late, so it passes under the battery, not through it.
      // On a phone the battery's corner is close: the turn comes as late as the curve allows (k2 0, the 16 px
      // control minimum), so even a 16 px stroke clears it. A wider card has room to ease it out to 0.15.
      flowEdge(
        'sol',
        'load',
        'b',
        -28 * k,
        't',
        -58 * k,
        1,
        Math.min(0.15, Math.max(0, (k - 1.2) * 0.6)),
      ),
      flowEdge('sol', 'bat', 'b', 30 * k, 't', -24 * k),
      flowEdge('imp', 'bat', 'b', -34 * k, 't', 24 * k),
      // Its value sits high, clear of the loss stub.
      flowEdge('imp', 'load', 'b', 46 * k, 't', 48 * k, 0.5, 0.5, 0.22),
      flowEdge('bat', 'load', 'b', 30 * k, 't', 0),
      flowEdge('bat', 'exp', 'b', -20 * k, 't', 20 * k),
    ],
    loss: { side: 'r', offset: 4, length: Math.min(30, 18 * k) },
  }
}

const NORMAL: Record<Side, [number, number]> = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] }

function port(n: FlowNode, side: Side, offset: number): Port {
  const [dx, dy] = NORMAL[side]
  return {
    x: n.x + (dx * n.w) / 2 + (dy !== 0 ? offset : 0),
    y: n.y + (dy * n.h) / 2 + (dx !== 0 ? offset : 0),
    dx,
    dy,
  }
}

/** A cubic from the source port to just outside the target port; the arrowhead fills the last 9 px. */
export function flowCurve<K extends string>(layout: FlowGraph<K>, e: FlowEdgeSpec<K>) {
  const a = port(layout.nodes[e.from], e.fromSide, e.fromOffset)
  const tip = port(layout.nodes[e.to], e.toSide, e.toOffset)
  const end = { x: tip.x + tip.dx * ARROW_LENGTH, y: tip.y + tip.dy * ARROW_LENGTH }
  const k1 = Math.max(16, e.k1 * Math.abs(a.dx ? end.x - a.x : end.y - a.y))
  const k2 = Math.max(16, e.k2 * Math.abs(tip.dx ? end.x - a.x : end.y - a.y))
  const c1 = { x: a.x + a.dx * k1, y: a.y + a.dy * k1 }
  const c2 = { x: end.x + tip.dx * k2, y: end.y + tip.dy * k2 }
  const at = (t: number): Point => {
    const m = 1 - t
    return {
      x: m ** 3 * a.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t ** 3 * end.x,
      y: m ** 3 * a.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t ** 3 * end.y,
    }
  }
  return { d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`, at, tip }
}

/** A triangle from the tip (on the node edge) back along the side's normal. */
export function arrowHead(tip: Port, width: number): string {
  const half = Math.max(5, width / 2 + 4)
  const bx = tip.x + tip.dx * ARROW_LENGTH
  const by = tip.y + tip.dy * ARROW_LENGTH
  const px = -tip.dy
  const py = tip.dx
  return `${tip.x},${tip.y} ${bx + px * half},${by + py * half} ${bx - px * half},${by - py * half}`
}

/**
 * Linear in kWh (the widths are the data), with a floor so a small flow stays visible. Without a positive
 * largest arrow (nothing drawn) there is no scale: the floor.
 */
export function flowWidth(kwh: number, max: number, narrow: boolean): number {
  if (!(max > 0)) return 2
  return Math.max(2, ((narrow ? 16 : 20) * kwh) / max)
}

export function edgeKwh(f: EnergyFigures, from: FlowNodeKey, to: FlowNodeKey): number {
  switch (`${from}>${to}`) {
    case 'sol>load':
      return f.solarDirect
    case 'sol>bat':
      return f.solarToBattery
    case 'sol>exp':
      return f.solarExported
    case 'imp>load':
      return f.importDirect
    case 'imp>bat':
      return f.importToBattery
    case 'bat>load':
      return f.batteryToHouse
    case 'bat>exp':
      return f.batteryToGrid
    default:
      return 0
  }
}

export function drawnFlows(layout: FlowLayout, f: EnergyFigures) {
  return layout.edges
    .map((spec) => ({ spec, kwh: edgeKwh(f, spec.from, spec.to) }))
    .filter((x) => x.kwh >= MIN_FLOW_KWH)
}

/** A loss that isn't a finite number reads "≈ 0" too, rather than drawing a stub from it. */
export function lossLabel(lossKwh: number): 'about-zero' | 'value' {
  return Number.isFinite(lossKwh) && lossKwh >= MIN_LOSS_KWH ? 'value' : 'about-zero'
}

/** The stub that leaves the battery, on the arrows' width scale (4 px floor), or null when the loss reads ≈ 0. */
export function lossStub(layout: FlowLayout, lossKwh: number, max: number) {
  if (lossLabel(lossKwh) === 'about-zero') return null
  const b = layout.nodes.bat
  const w = Math.max(4, flowWidth(lossKwh, max, layout.narrow))
  const { side, offset, length } = layout.loss
  return side === 'b'
    ? { side, x: b.x + offset - w / 2, y: b.y + b.h / 2, width: w, height: length }
    : { side, x: b.x + b.w / 2, y: b.y + offset - w / 2, width: length, height: w }
}

export type NodeText = {
  tile: { x: number; y: number; size: number; icon: number }
  label: Point
  /**
   * The node's figure; on the battery, its loss. `room` is how far its text may run (to 12 px inside the node);
   * a longer one steps its font size down 2 px at a time, to `minSize`.
   */
  value: Point & { size: number; minSize: number; room: number }
  /** Förbrukning's first car line; null on every other node. */
  second: Point | null
  /** Förbrukning's second car line, or the battery's stored-energy line (wide only); null elsewhere. */
  third: Point | null
}

/**
 * Where a node's tile and text go. Wide: the tile left of the text, the text block (label cap top to the last
 * baseline, cap height ≈ 0.7 em) centred on the tile. Narrow: the tile and the label share the first row, the
 * figure runs the node's width below. The battery's `value` is its loss; the change in stored energy (from the
 * start and end charge levels) is `third` on the wide layout (narrow: it is in the table); without one (`chargeLine`
 * false: a SoC is missing) the label and the loss move down to stay centred. Förbrukning's two car lines are
 * `second` and `third`.
 */
export function nodeText(
  node: FlowNode,
  key: FlowNodeKey,
  narrow: boolean,
  { chargeLine = true }: { chargeLine?: boolean } = {},
): NodeText {
  const x0 = node.x - node.w / 2
  const y0 = node.y - node.h / 2
  const value = (x: number, y: number, size: number) => ({
    x,
    y,
    size,
    minSize: key === 'bat' ? LOSS_MIN_SIZE : FIGURE_MIN_SIZE,
    room: x0 + node.w - NODE_PADDING - x,
  })
  if (narrow) {
    const tile = { x: x0 + 12, y: y0 + 10, size: 34, icon: 20 }
    const label = { x: tile.x + 34 + 10, y: tile.y + 22 }
    if (key === 'bat')
      return { tile, label, value: value(x0 + 12, y0 + 70, 18), second: null, third: null }
    const car = key === 'load'
    return {
      tile,
      label,
      value: value(x0 + 12, y0 + 72, 24),
      second: car ? { x: x0 + 12, y: y0 + node.h - 32 } : null,
      third: car ? { x: x0 + 12, y: y0 + node.h - 13 } : null,
    }
  }
  if (key === 'bat') {
    const tile = { x: x0 + 12, y: y0 + (node.h - 48) / 2, size: 48, icon: 28 }
    const tx = tile.x + 48 + 12
    // Half the charge line's 19 px step, so the two remaining rows sit where the three did.
    const dy = chargeLine ? 0 : 9.5
    return {
      tile,
      label: { x: tx, y: y0 + 25 + dy },
      value: value(tx, y0 + 50 + dy, 20),
      second: null,
      third: chargeLine ? { x: tx, y: y0 + 69 } : null,
    }
  }
  const tile = { x: x0 + 12, y: y0 + 16, size: 48, icon: 28 }
  const tx = tile.x + 48 + 12
  const car = key === 'load'
  return {
    tile,
    label: { x: tx, y: tile.y + 14 },
    value: value(tx, tile.y + 44, 28),
    second: car ? { x: tx, y: y0 + node.h - 32 } : null,
    third: car ? { x: tx, y: y0 + node.h - 13 } : null,
  }
}
