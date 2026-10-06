import { Group } from '@visx/group'
import {
  BatteryMediumIcon,
  CoinsIcon,
  HouseIcon,
  type LucideIcon,
  SolarPanelIcon,
  UtilityPoleIcon,
} from 'lucide-react'
import type * as React from 'react'
import { useId, useRef } from 'react'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import {
  formatOneDecimal,
  formatShare,
  formatSignedOneDecimal,
} from '~/components/evCharging/format'
import { type EnergyFigures, type PeriodSums, WINTER_LOSS_SHARE } from '~/lib/houseEnergy/figures'
import {
  arrowHead,
  drawnFlows,
  type FlowNodeKey,
  flowCurve,
  flowLayout,
  flowWidth,
  lossLabel,
  lossStub,
  MIN_FLOW_KWH,
  nodeText,
} from '~/lib/houseEnergy/flowLayout'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { NODE_MUTED, NodeFrame, useFittedSize, ValuePill } from './flowParts'

// The Summering card's flow diagram (step 1c): where the period's energy came from and went. Geometry lives in
// flowLayout.ts; this draws it. Colour = where the energy came from (three validated source colours only).
const SOURCE_COLOR: Partial<Record<FlowNodeKey, string>> = {
  sol: 'var(--energy-solar)',
  imp: 'var(--energy-grid)',
  bat: 'var(--energy-battery)',
}
const ICON: Record<FlowNodeKey, LucideIcon> = {
  sol: SolarPanelIcon,
  imp: UtilityPoleIcon,
  bat: BatteryMediumIcon,
  load: HouseIcon,
  exp: CoinsIcon,
}
// The battery shows its loss instead (figures.ts).
const FIGURE: Record<Exclude<FlowNodeKey, 'bat'>, (s: PeriodSums) => number> = {
  sol: (s) => s.solarKwh,
  imp: (s) => s.gridImportKwh,
  exp: (s) => s.gridExportKwh,
  load: (s) => s.loadKwh,
}
const label = (key: FlowNodeKey) =>
  ({
    sol: m.energy_tile_solar(),
    imp: m.energy_tile_import(),
    bat: m.energy_flow_battery(),
    load: m.energy_tile_load(),
    exp: m.energy_tile_export(),
  })[key]
const kwh = (v: number) => formatOneDecimal(v)

type Tip =
  | {
      kind: 'flow'
      id: string
      from: FlowNodeKey
      to: FlowNodeKey
      kwh: number
      share: string | null
    }
  | {
      kind: 'loss'
      id: 'loss'
      kwh: number
      share: string | null
      charge: string | null
      winter: boolean
    }

function flowShare(
  f: EnergyFigures,
  sums: PeriodSums,
  from: FlowNodeKey,
  to: FlowNodeKey,
  value: number,
): string | null {
  if (from === 'sol') {
    // As the old tiles: normalised so an overshoot never reads above 100 %.
    const total = Math.max(sums.solarKwh, f.solarDirect + f.solarToBattery + f.solarExported)
    return total > 0 ? m.energy_flow_share_solar({ share: formatShare(value / total) }) : null
  }
  if (from === 'imp')
    return sums.gridImportKwh > 0
      ? m.energy_flow_share_import({ share: formatShare(value / sums.gridImportKwh) })
      : null
  // Sold energy never reached the house: no share line.
  if (to === 'exp') return null
  return sums.loadKwh > 0
    ? m.energy_flow_share_load({ share: formatShare(value / sums.loadKwh) })
    : null
}

export function EnergyFlowDiagram({
  sums,
  figures: f,
  width,
  showValues,
}: {
  sums: PeriodSums
  figures: EnergyFigures
  width: number
  showValues: boolean
}) {
  const layout = flowLayout(width)
  const popover = useChartPopover<Tip>()
  const { markProps, containerProps, hide } = popover
  // A mouse leaving an arrow closes its popover (touch keeps it until a tap outside, as in the heatmaps).
  const leaveProps = {
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') hide()
    },
  }
  const fadeId = `loss-fade-${useId()}`
  const flows = drawnFlows(layout, f)
  // flowWidth and lossStub fall back to the floor when nothing is drawn (max 0).
  const max = Math.max(0, ...flows.map((x) => x.kwh))
  const stub = lossStub(layout, f.loss, max)
  const charge =
    sums.firstSocPct !== null && sums.lastSocPct !== null
      ? m.energy_flow_charge_level({
          from: String(Math.round(sums.firstSocPct)),
          to: String(Math.round(sums.lastSocPct)),
        })
      : null
  // The battery node's last line (wide only): how much more or less is stored at the end than at the start.
  const stored =
    sums.firstSocPct !== null && sums.lastSocPct !== null
      ? m.energy_flow_stored({ kwh: formatSignedOneDecimal(f.deltaStored) })
      : null
  const active = popover.open ? popover.data?.id : undefined
  const dim = (id: string) => (active !== undefined && active !== id ? 'opacity-25' : undefined)

  return (
    <div {...containerProps} className="relative">
      <svg
        width={width}
        height={layout.height}
        role="img"
        aria-label={m.energy_flow_description()}
        className="block overflow-visible"
      >
        <defs>
          <linearGradient
            id={fadeId}
            x1={0}
            y1={0}
            x2={layout.loss.side === 'r' ? 1 : 0}
            y2={layout.loss.side === 'b' ? 1 : 0}
          >
            <stop offset={0} stopColor="var(--energy-battery)" stopOpacity={0.9} />
            <stop offset={1} stopColor="var(--energy-battery)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* Arrows under the nodes; pills and hit areas over them. */}
        <Group>
          {flows.map(({ spec, kwh: v }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const w = flowWidth(v, max, layout.narrow)
            const color = SOURCE_COLOR[spec.from]
            return (
              <g
                key={id}
                data-flow-edge={id}
                className={cn('transition-opacity motion-reduce:transition-none', dim(id))}
              >
                <path d={c.d} fill="none" stroke={color} strokeWidth={w} />
                <polygon points={arrowHead(c.tip, w)} fill={color} />
              </g>
            )
          })}
          {stub ? (
            <rect
              data-slot="flow-loss"
              x={stub.x}
              y={stub.y}
              width={stub.width}
              height={stub.height}
              fill={`url(#${fadeId})`}
              className={cn('transition-opacity motion-reduce:transition-none', dim('loss'))}
            />
          ) : null}
        </Group>
        <Group>
          {(Object.keys(layout.nodes) as FlowNodeKey[]).map((key) => (
            <FlowNodeBox
              key={key}
              nodeKey={key}
              layout={layout}
              f={f}
              sums={sums}
              stored={stored}
            />
          ))}
        </Group>
        <Group>
          {showValues
            ? flows.map(({ spec, kwh: v }) => {
                const p = flowCurve(layout, spec).at(spec.labelT)
                return (
                  <ValuePill
                    key={`${spec.from}>${spec.to}`}
                    x={p.x}
                    y={p.y}
                    text={kwh(v)}
                    className={cn(
                      'transition-opacity motion-reduce:transition-none',
                      dim(`${spec.from}>${spec.to}`),
                    )}
                  />
                )
              })
            : null}
          {flows.map(({ spec, kwh: v }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const mid = c.at(spec.labelT)
            const tip: Tip = {
              kind: 'flow',
              id,
              from: spec.from,
              to: spec.to,
              kwh: v,
              share: flowShare(f, sums, spec.from, spec.to, v),
            }
            return (
              <g key={id}>
                <path
                  data-flow-hit={id}
                  data-slot="flow-hit"
                  d={c.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(22, flowWidth(v, max, layout.narrow))}
                  pointerEvents="stroke"
                  className="cursor-pointer"
                  {...markProps(tip, mid.x, mid.y)}
                  {...leaveProps}
                />
              </g>
            )
          })}
          {stub ? (
            <rect
              x={stub.x - 8}
              y={stub.y - 8}
              width={stub.width + 16}
              height={stub.height + 16}
              fill="transparent"
              className="cursor-pointer"
              {...leaveProps}
              {...markProps(
                {
                  kind: 'loss',
                  id: 'loss',
                  kwh: f.loss,
                  share:
                    f.lossShare !== null
                      ? m.energy_flow_loss_share({ share: formatShare(f.lossShare) })
                      : null,
                  charge,
                  winter: f.lossShare !== null && f.lossShare > WINTER_LOSS_SHARE,
                },
                stub.x + stub.width / 2,
                stub.y + stub.height / 2,
              )}
            />
          ) : null}
        </Group>
      </svg>
      {/* Above, not over: the arrow's own value pill sits where the pointer anchors the tooltip. */}
      <ChartPopover
        state={popover}
        dataKey={popover.data?.id}
        placement="above"
        className="flex min-w-48 flex-col gap-0.5 whitespace-normal rounded-lg border bg-card px-3 py-2 text-card-foreground text-sm shadow-lg"
      >
        {popover.data ? <TipBody tip={popover.data} /> : null}
      </ChartPopover>
    </div>
  )
}

function TipBody({ tip }: { tip: Tip }) {
  if (tip.kind === 'loss') {
    return (
      <>
        <span className="flex items-center gap-2 font-semibold">
          <span aria-hidden className="size-2.5 rounded-xs bg-energy-battery" />
          {m.energy_flow_loss_title()}
        </span>
        <span className="font-semibold text-base tabular-nums">{kwh(tip.kwh)} kWh</span>
        {tip.share ? <span className="text-muted-foreground">{tip.share}</span> : null}
        {tip.charge ? <span className="text-muted-foreground">{tip.charge}</span> : null}
        {tip.winter ? (
          <span className="max-w-64 text-muted-foreground">{m.energy_flow_winter_hint()}</span>
        ) : null}
      </>
    )
  }
  const color = SOURCE_COLOR[tip.from]
  return (
    <>
      <span className="flex items-center gap-2 font-semibold">
        <span aria-hidden className="size-2.5 rounded-xs" style={{ background: color }} />
        {m.energy_flow_arrow({ from: label(tip.from), to: label(tip.to) })}
      </span>
      <span className="font-semibold text-base tabular-nums">{kwh(tip.kwh)} kWh</span>
      {tip.share ? <span className="text-muted-foreground">{tip.share}</span> : null}
    </>
  )
}

function FlowNodeBox({
  nodeKey: key,
  layout,
  f,
  sums,
  stored,
}: {
  nodeKey: FlowNodeKey
  layout: ReturnType<typeof flowLayout>
  f: EnergyFigures
  sums: PeriodSums
  stored: string | null
}) {
  const n = layout.nodes[key]
  const t = nodeText(n, key, layout.narrow, { chargeLine: stored !== null })
  const Icon = ICON[key]
  const tint = SOURCE_COLOR[key]
  const value =
    key === 'bat'
      ? lossLabel(f.loss) === 'about-zero'
        ? m.energy_flow_about_zero()
        : kwh(f.loss)
      : kwh(FIGURE[key](sums))
  const valueRef = useRef<SVGTextElement>(null)
  const size = useFittedSize(valueRef, value, t.value)
  return (
    <NodeFrame
      data-flow-node={key}
      node={n}
      tile={t.tile}
      label={t.label}
      labelText={label(key)}
      Icon={Icon}
      tint={tint}
    >
      {key === 'bat' ? (
        <>
          <text ref={valueRef} x={t.value.x} y={t.value.y} fontSize={14} style={NODE_MUTED}>
            {m.energy_flow_loss()}{' '}
            <tspan fontSize={size} fontWeight={600} className="fill-foreground tabular-nums">
              {value}
            </tspan>{' '}
            kWh
          </text>
          {t.third && stored ? (
            <text
              x={t.third.x}
              y={t.third.y}
              fontSize={13}
              style={NODE_MUTED}
              className="tabular-nums"
            >
              {stored}
            </text>
          ) : null}
        </>
      ) : (
        <text
          ref={valueRef}
          x={t.value.x}
          y={t.value.y}
          fontSize={size}
          fontWeight={600}
          className="fill-foreground tabular-nums"
        >
          {value}{' '}
          <tspan fontSize={14} fontWeight={400} style={NODE_MUTED}>
            kWh
          </tspan>
        </text>
      )}
      {/* Like an arrow, a car part that would read "0,0" is left out; its lines keep their space. */}
      {key === 'load' && f.car >= MIN_FLOW_KWH && t.second && t.third ? (
        <>
          <text x={t.second.x} y={t.second.y} fontSize={14} style={NODE_MUTED}>
            {m.energy_flow_car()}
          </text>
          <text
            x={t.third.x}
            y={t.third.y}
            fontSize={14}
            className="tabular-nums"
            style={NODE_MUTED}
          >
            {kwh(f.car)} kWh
          </text>
        </>
      ) : null}
    </NodeFrame>
  )
}
