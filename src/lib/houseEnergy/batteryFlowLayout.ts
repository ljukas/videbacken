// Client-safe, pure (step 2, ADR-0024). The Batteri page's flow diagram geometry: solar and bought into the
// battery, out and the loss from it. Two nodes on each side, every arrow joining the battery, so none cross.
// Numbers from the approved mockup (battery page design, "Geometry"); built on step 1c's primitives.
import type { EnergyFigures } from './figures'
import {
  FIGURE_MIN_SIZE,
  type FlowEdgeSpec,
  type FlowGraph,
  type FlowNode,
  flowEdge,
  lossLabel,
  MIN_FLOW_KWH,
  NODE_PADDING,
  type NodeText,
  WIDE_MIN_WIDTH,
} from './flowLayout'

export type BatteryNodeKey = 'sol' | 'imp' | 'bat' | 'out' | 'loss'
export const BATTERY_WIDE_HEIGHT = 300
export const BATTERY_NARROW_HEIGHT = 430

export function batteryFlowLayout(width: number): FlowGraph<BatteryNodeKey> {
  if (width >= WIDE_MIN_WIDTH) {
    const nw = 236
    const H = BATTERY_WIDE_HEIGHT
    const L = nw / 2 + 1
    const R = width - nw / 2 - 1
    return {
      narrow: false,
      height: H,
      nodes: {
        sol: { x: L, y: 50, w: nw, h: 80 },
        imp: { x: L, y: H - 50, w: nw, h: 80 },
        bat: { x: width / 2, y: H / 2, w: 220, h: 84 },
        out: { x: R, y: 50, w: nw, h: 92 },
        loss: { x: R, y: H - 50, w: nw, h: 92 },
      },
      edges: [
        flowEdge<BatteryNodeKey>('sol', 'bat', 'r', 0, 'l', -20),
        flowEdge<BatteryNodeKey>('imp', 'bat', 'r', 0, 'l', 20),
        flowEdge<BatteryNodeKey>('bat', 'out', 'r', -20, 'l', 0),
        flowEdge<BatteryNodeKey>('bat', 'loss', 'r', 20, 'l', 0),
      ],
    }
  }
  // 124 px is the least that leaves a figure its 100 px of room; below ~272 px the nodes' gap shrinks to 6 px.
  const nw = Math.min(220, Math.max(124, Math.floor((width - 24) / 2)))
  const H = BATTERY_NARROW_HEIGHT
  // Offsets tuned at a 146 px node (as step 1c's narrow layout); they scale with it.
  const k = nw / 146
  const L = nw / 2 + 1
  const R = width - nw / 2 - 1
  return {
    narrow: true,
    height: H,
    nodes: {
      sol: { x: L, y: 43, w: nw, h: 82 },
      imp: { x: R, y: 43, w: nw, h: 82 },
      bat: { x: width / 2, y: H / 2, w: Math.min(190, nw + 30), h: 82 },
      out: { x: L, y: H - 51, w: nw, h: 98 },
      loss: { x: R, y: H - 51, w: nw, h: 98 },
    },
    edges: [
      flowEdge<BatteryNodeKey>('sol', 'bat', 'b', 20 * k, 't', -30 * k),
      flowEdge<BatteryNodeKey>('imp', 'bat', 'b', -20 * k, 't', 30 * k),
      flowEdge<BatteryNodeKey>('bat', 'out', 'b', -30 * k, 't', 20 * k),
      flowEdge<BatteryNodeKey>('bat', 'loss', 'b', 30 * k, 't', -20 * k),
    ],
  }
}

/** What each arrow carries. The loss arrow exists only when the loss reads as a value (≥ 0,5 kWh). */
export function batteryEdgeKwh(f: EnergyFigures, from: BatteryNodeKey, to: BatteryNodeKey): number {
  switch (`${from}>${to}`) {
    case 'sol>bat':
      return f.solarToBattery
    case 'imp>bat':
      // batteryIn = solar + charge_grid; batteryChargeGridKwh already sums charge_grid + charge_ac in the service
      // (services/houseEnergy/energyOverview.ts, hourly CTE): the bought part of what went in.
      return f.batteryIn - f.solarToBattery
    case 'bat>out':
      return f.batteryOut
    case 'bat>loss':
      return lossLabel(f.loss) === 'value' ? f.loss : 0
    default:
      return 0
  }
}

export function batteryDrawnFlows(layout: FlowGraph<BatteryNodeKey>, f: EnergyFigures) {
  return layout.edges
    .map((spec: FlowEdgeSpec<BatteryNodeKey>) => ({
      spec,
      kwh: batteryEdgeKwh(f, spec.from, spec.to),
    }))
    .filter((x) => x.kwh >= MIN_FLOW_KWH)
}

/**
 * Where a node's tile and text go (step 1c's rules). Wide: the tile left, label and figure beside it; the battery
 * centres its two rows (label, "Lager ±") on its tile. Narrow: tile and label in the first row, the figure below.
 * `second` is Ut's "varav såld" line (both layouts) or Förlust's share line (wide only: a phone node is too narrow;
 * the share is in the tooltip and the table).
 */
export function batteryNodeText(node: FlowNode, key: BatteryNodeKey, narrow: boolean): NodeText {
  const x0 = node.x - node.w / 2
  const y0 = node.y - node.h / 2
  const value = (x: number, y: number, size: number) => ({
    x,
    y,
    size,
    minSize: FIGURE_MIN_SIZE,
    room: x0 + node.w - NODE_PADDING - x,
  })
  const lastLine = { x: 0, y: y0 + node.h - 12 }
  if (narrow) {
    const tile = { x: x0 + 12, y: y0 + 10, size: 34, icon: 20 }
    const label = { x: tile.x + 34 + 10, y: tile.y + 22 }
    if (key === 'bat')
      return { tile, label, value: value(x0 + 12, y0 + 70, 18), second: null, third: null }
    return {
      tile,
      label,
      value: value(x0 + 12, y0 + 72, 24),
      second: key === 'out' ? { ...lastLine, x: x0 + 12 } : null,
      third: null,
    }
  }
  if (key === 'bat') {
    const tile = { x: x0 + 12, y: y0 + (node.h - 48) / 2, size: 48, icon: 28 }
    const tx = tile.x + 48 + 12
    // Two rows centred on the tile (step 1c's battery without its third line).
    return {
      tile,
      label: { x: tx, y: y0 + 34.5 },
      value: value(tx, y0 + 59.5, 20),
      second: null,
      third: null,
    }
  }
  const tile = { x: x0 + 12, y: y0 + 16, size: 48, icon: 28 }
  const tx = tile.x + 48 + 12
  return {
    tile,
    label: { x: tx, y: tile.y + 14 },
    value: value(tx, tile.y + 44, 28),
    // Under the tile, not beside it: from `tx` the ~26-char share line would overflow the node.
    second: key === 'out' || key === 'loss' ? { ...lastLine, x: x0 + NODE_PADDING } : null,
    third: null,
  }
}
