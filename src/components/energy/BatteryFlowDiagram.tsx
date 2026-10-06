import { Group } from '@visx/group'
import {
  BatteryMediumIcon,
  FlameIcon,
  HouseIcon,
  type LucideIcon,
  SolarPanelIcon,
  UtilityPoleIcon,
} from 'lucide-react'
import type * as React from 'react'
import { useRef } from 'react'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import {
  formatOneDecimal,
  formatShare,
  formatSignedOneDecimal,
} from '~/components/evCharging/format'
import {
  type BatteryNodeKey,
  batteryDrawnFlows,
  batteryFlowLayout,
  batteryNodeText,
} from '~/lib/houseEnergy/batteryFlowLayout'
import { type EnergyFigures, type PeriodSums, WINTER_LOSS_SHARE } from '~/lib/houseEnergy/figures'
import {
  arrowHead,
  flowCurve,
  flowWidth,
  lossLabel,
  MIN_FLOW_KWH,
  NODE_PADDING,
} from '~/lib/houseEnergy/flowLayout'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { NODE_MUTED, NodeFrame, useFittedSize, ValuePill } from './flowParts'

// The Batteri page's Summering diagram (step 2): what went into the battery (by origin), what came out and what
// was lost. Geometry in batteryFlowLayout.ts. Colour = where the energy came from; the loss is red.
const COLOR: Record<BatteryNodeKey, string | undefined> = {
  sol: 'var(--energy-solar)',
  imp: 'var(--energy-grid)',
  bat: 'var(--energy-battery)',
  out: undefined,
  loss: 'var(--energy-loss)',
}
const ICON: Record<BatteryNodeKey, LucideIcon> = {
  sol: SolarPanelIcon,
  imp: UtilityPoleIcon,
  bat: BatteryMediumIcon,
  out: HouseIcon,
  loss: FlameIcon,
}
const label = (key: BatteryNodeKey) =>
  ({
    sol: m.energy_tile_solar(),
    imp: m.energy_tile_import(),
    bat: m.energy_flow_battery(),
    out: m.energy_battery_node_out(),
    loss: m.energy_flow_loss(),
  })[key]
const kwh = (v: number) => formatOneDecimal(v)
// The loss arrow is red; the others take their source's colour (the battery's, for Ut).
const arrowColor = (from: BatteryNodeKey, to: BatteryNodeKey) =>
  to === 'loss' ? COLOR.loss : COLOR[from]

type Tip = { id: string; from: BatteryNodeKey; to: BatteryNodeKey; kwh: number; lines: string[] }

function tipLines(
  f: EnergyFigures,
  sums: PeriodSums,
  from: BatteryNodeKey,
  to: BatteryNodeKey,
): string[] {
  if (to === 'bat') {
    // figures.ts's definition; null (the battery barely ran) means no share.
    if (f.gridChargedShare === null) return []
    const share = from === 'imp' ? f.gridChargedShare : 1 - f.gridChargedShare
    return [m.energy_battery_in_share({ share: formatShare(share) })]
  }
  if (to === 'out')
    return [
      f.batteryToGrid >= MIN_FLOW_KWH
        ? m.energy_battery_out_split({ house: kwh(f.batteryToHouse), sold: kwh(f.batteryToGrid) })
        : m.energy_battery_out_house(),
    ]
  const lines: string[] = []
  if (f.lossShare !== null)
    lines.push(m.energy_flow_loss_share({ share: formatShare(f.lossShare) }))
  if (sums.firstSocPct !== null && sums.lastSocPct !== null)
    lines.push(
      m.energy_flow_charge_level({
        from: String(Math.round(sums.firstSocPct)),
        to: String(Math.round(sums.lastSocPct)),
      }),
    )
  if (f.lossShare !== null && f.lossShare > WINTER_LOSS_SHARE)
    lines.push(m.energy_flow_winter_hint())
  return lines
}

export function BatteryFlowDiagram({
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
  const layout = batteryFlowLayout(width)
  const popover = useChartPopover<Tip>()
  const { markProps, containerProps, hide } = popover
  // A mouse leaving an arrow closes its popover (touch keeps it until a tap outside, as in Översikt).
  const leaveProps = {
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') hide()
    },
  }
  const flows = batteryDrawnFlows(layout, f)
  const max = Math.max(0, ...flows.map((x) => x.kwh))
  const active = popover.open ? popover.data?.id : undefined
  const dim = (id: string) => (active !== undefined && active !== id ? 'opacity-25' : undefined)
  const fade = 'transition-opacity motion-reduce:transition-none'

  return (
    <div {...containerProps} className="relative">
      <svg
        width={width}
        height={layout.height}
        role="img"
        aria-label={m.energy_battery_flow_description()}
        className="block overflow-visible"
      >
        {/* Arrows under the nodes; pills and hit areas over them. */}
        <Group>
          {flows.map(({ spec, kwh: v }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const w = flowWidth(v, max, layout.narrow)
            const color = arrowColor(spec.from, spec.to)
            return (
              <g key={id} data-flow-edge={id} className={cn(fade, dim(id))}>
                <path d={c.d} fill="none" stroke={color} strokeWidth={w} />
                <polygon points={arrowHead(c.tip, w)} fill={color} />
              </g>
            )
          })}
        </Group>
        <Group>
          {(Object.keys(layout.nodes) as BatteryNodeKey[]).map((key) => (
            <BatteryNode
              key={key}
              nodeKey={key}
              layout={layout}
              f={f}
              socKnown={sums.firstSocPct !== null && sums.lastSocPct !== null}
            />
          ))}
        </Group>
        <Group>
          {showValues
            ? flows.map(({ spec, kwh: v }) => {
                const id = `${spec.from}>${spec.to}`
                const p = flowCurve(layout, spec).at(spec.labelT)
                return (
                  <ValuePill key={id} x={p.x} y={p.y} text={kwh(v)} className={cn(fade, dim(id))} />
                )
              })
            : null}
          {flows.map(({ spec, kwh: v }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const mid = c.at(spec.labelT)
            return (
              <path
                key={id}
                data-flow-hit={id}
                data-slot="flow-hit"
                d={c.d}
                fill="none"
                stroke="transparent"
                strokeWidth={Math.max(22, flowWidth(v, max, layout.narrow))}
                pointerEvents="stroke"
                className="cursor-pointer"
                {...markProps(
                  {
                    id,
                    from: spec.from,
                    to: spec.to,
                    kwh: v,
                    lines: tipLines(f, sums, spec.from, spec.to),
                  },
                  mid.x,
                  mid.y,
                )}
                {...leaveProps}
              />
            )
          })}
        </Group>
      </svg>
      <ChartPopover
        state={popover}
        dataKey={popover.data?.id}
        placement="above"
        className="flex min-w-48 flex-col gap-0.5 whitespace-normal rounded-lg border bg-card px-3 py-2 text-card-foreground text-sm shadow-lg"
      >
        {popover.data ? (
          <>
            <span className="flex items-center gap-2 font-semibold">
              <span
                aria-hidden
                className="size-2.5 rounded-xs"
                style={{ background: arrowColor(popover.data.from, popover.data.to) }}
              />
              {m.energy_flow_arrow({
                from: label(popover.data.from),
                to: label(popover.data.to),
              })}
            </span>
            <span className="font-semibold text-base tabular-nums">
              {kwh(popover.data.kwh)} kWh
            </span>
            {popover.data.lines.map((line) => (
              <span key={line} className="max-w-64 text-muted-foreground">
                {line}
              </span>
            ))}
          </>
        ) : null}
      </ChartPopover>
    </div>
  )
}

function BatteryNode({
  nodeKey: key,
  layout,
  f,
  socKnown,
}: {
  nodeKey: BatteryNodeKey
  layout: ReturnType<typeof batteryFlowLayout>
  f: EnergyFigures
  socKnown: boolean
}) {
  const n = layout.nodes[key]
  const t = batteryNodeText(n, key, layout.narrow)
  const value =
    key === 'bat'
      ? socKnown
        ? formatSignedOneDecimal(f.deltaStored)
        : '—'
      : key === 'loss'
        ? lossLabel(f.loss) === 'about-zero'
          ? m.energy_flow_about_zero()
          : kwh(f.loss)
        : kwh(
            { sol: f.solarToBattery, imp: f.batteryIn - f.solarToBattery, out: f.batteryOut }[key],
          )
  const valueRef = useRef<SVGTextElement>(null)
  const size = useFittedSize(valueRef, value, t.value)
  // Ut: "varav såld" only with a sale; Förlust: its share only when it reads as a value.
  const second =
    key === 'out' && f.batteryToGrid >= MIN_FLOW_KWH
      ? m.energy_battery_out_sold({ kwh: kwh(f.batteryToGrid) })
      : key === 'loss' && lossLabel(f.loss) === 'value' && f.lossShare !== null
        ? m.energy_flow_loss_share({ share: formatShare(f.lossShare) })
        : null
  // The second line shrinks 13 → 11 px to stay inside the node (a phone node leaves ~114 px).
  const secondRef = useRef<SVGTextElement>(null)
  const secondSize = useFittedSize(secondRef, second ?? '', {
    x: t.second?.x ?? 0,
    size: 13,
    minSize: 11,
    room: t.second ? n.x + n.w / 2 - NODE_PADDING - t.second.x : 0,
  })
  return (
    <NodeFrame
      data-flow-node={key}
      node={n}
      tile={t.tile}
      label={t.label}
      labelText={label(key)}
      Icon={ICON[key]}
      tint={COLOR[key]}
    >
      {key === 'bat' ? (
        <text ref={valueRef} x={t.value.x} y={t.value.y} fontSize={14} style={NODE_MUTED}>
          {m.energy_battery_stored_label()}{' '}
          <tspan fontSize={size} fontWeight={600} className="fill-foreground tabular-nums">
            {value}
          </tspan>
          {socKnown ? ' kWh' : null}
        </text>
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
      {t.second && second ? (
        <text
          ref={secondRef}
          x={t.second.x}
          y={t.second.y}
          fontSize={secondSize}
          style={NODE_MUTED}
          className="tabular-nums"
        >
          {second}
        </text>
      ) : null}
    </NodeFrame>
  )
}
