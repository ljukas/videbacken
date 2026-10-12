import { Group } from '@visx/group'
import { AirVentIcon, CarIcon, HouseIcon, HousePlugIcon, type LucideIcon } from 'lucide-react'
import type * as React from 'react'
import { useRef } from 'react'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import type { EnergyFigures, PeriodSums } from '~/lib/houseEnergy/figures'
import { arrowHead, flowCurve, NODE_PADDING } from '~/lib/houseEnergy/flowLayout'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import {
  type UseConsumerKey,
  type UseNodeKey,
  usageConsumers,
  usageFlowLayout,
  usageNodeText,
} from '~/lib/houseEnergy/usageFlowLayout'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { NODE_MUTED, NodeFrame, useFittedSize, useFittedText, ValuePill } from './flowParts'

// The Användning card's diagram (heat pumps step 2): the period's load split into laddning, each heat pump and övrigt
// hus. Geometry in usageFlowLayout.ts; this draws it. Colour = the consumer (laddning, the unit by its all-time place,
// övrigt hus); text never wears a series colour.
type Consumer = {
  label: string
  color: string
  Icon: LucideIcon
  kwh: number
  share: number | null
}
type Tip = { id: string; label: string; color: string; kwh: number; share: number | null }

const kwh = (v: number) => formatOneDecimal(v)

function consumersOf(
  sums: PeriodSums,
  f: EnergyFigures,
  units: readonly { id: string }[],
): Map<UseConsumerKey, Consumer> {
  const share = (v: number) => (sums.loadKwh > 0 ? v / sums.loadKwh : null)
  const map = new Map<UseConsumerKey, Consumer>()
  map.set('car', {
    label: m.energy_series_car(),
    color: 'var(--energy-car)',
    Icon: CarIcon,
    kwh: f.car,
    share: share(f.car),
  })
  for (const u of f.heatPumps)
    map.set(`hp:${u.id}`, {
      label: m.energy_heat_pump_name({ name: u.name }),
      color: heatPumpColor(units, u.id),
      Icon: AirVentIcon,
      kwh: u.kwh,
      share: u.share,
    })
  map.set('house', {
    label: m.energy_use_house(),
    color: 'var(--energy-house)',
    Icon: HousePlugIcon,
    kwh: f.restOfHouse,
    share: share(f.restOfHouse),
  })
  return map
}

export function EnergyUseFlowDiagram({
  sums,
  figures: f,
  units,
  width,
  showValues,
}: {
  sums: PeriodSums
  figures: EnergyFigures
  /** Every unit in its all-time order: the colour order. */
  units: readonly { id: string }[]
  width: number
  showValues: boolean
}) {
  const layout = usageFlowLayout(width, usageConsumers(f))
  const consumers = consumersOf(sums, f, units)
  const popover = useChartPopover<Tip>()
  const { markProps, containerProps, hide } = popover
  // A mouse leaving an arrow closes its popover (touch keeps it until a tap outside, as in Summering).
  const leaveProps = {
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') hide()
    },
  }
  const active = popover.open ? popover.data?.id : undefined
  const dim = (id: string) => (active !== undefined && active !== id ? 'opacity-25' : undefined)
  const fade = 'transition-opacity motion-reduce:transition-none'
  return (
    <div {...containerProps} className="relative">
      <svg
        width={width}
        height={layout.height}
        role="img"
        aria-label={m.energy_use_description()}
        className="block overflow-visible"
      >
        {/* Arrows under the nodes; pills and hit areas over them. */}
        <Group>
          {layout.flows.map(({ spec, width: w }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const color = consumers.get(spec.to as UseConsumerKey)?.color
            return (
              <g key={id} data-flow-edge={id} className={cn(fade, dim(id))}>
                <path d={c.d} fill="none" stroke={color} strokeWidth={w} />
                <polygon points={arrowHead(c.tip, w)} fill={color} />
              </g>
            )
          })}
        </Group>
        <Group>
          {(Object.keys(layout.nodes) as UseNodeKey[]).map((key) => (
            <UseNode
              key={key}
              nodeKey={key}
              layout={layout}
              consumer={key === 'load' ? null : (consumers.get(key) ?? null)}
              loadKwh={sums.loadKwh}
            />
          ))}
        </Group>
        <Group>
          {/* Narrow: the arrows share a lane, so the values stay on the nodes. */}
          {showValues && !layout.narrow
            ? layout.flows.map(({ spec, kwh: v }) => {
                const id = `${spec.from}>${spec.to}`
                const p = flowCurve(layout, spec).at(spec.labelT)
                return (
                  <ValuePill key={id} x={p.x} y={p.y} text={kwh(v)} className={cn(fade, dim(id))} />
                )
              })
            : null}
          {layout.flows.map(({ spec, kwh: v, width: w }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const mid = c.at(spec.labelT)
            const consumer = consumers.get(spec.to as UseConsumerKey)
            return (
              <path
                key={id}
                data-flow-hit={id}
                data-slot="flow-hit"
                d={c.d}
                fill="none"
                stroke="transparent"
                strokeWidth={Math.max(22, w)}
                pointerEvents="stroke"
                className="cursor-pointer"
                {...markProps(
                  {
                    id,
                    label: consumer?.label ?? '',
                    color: consumer?.color ?? '',
                    kwh: v,
                    share: consumer?.share ?? null,
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
      {/* Above, not over: the arrow's own value pill sits where the pointer anchors the tooltip. */}
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
                style={{ background: popover.data.color }}
              />
              {m.energy_flow_arrow({ from: m.energy_tile_load(), to: popover.data.label })}
            </span>
            <span className="font-semibold text-base tabular-nums">
              {kwh(popover.data.kwh)} kWh
            </span>
            {popover.data.share !== null ? (
              <span className="text-muted-foreground">
                {m.energy_flow_share_load({ share: formatShare(popover.data.share) })}
              </span>
            ) : null}
          </>
        ) : null}
      </ChartPopover>
    </div>
  )
}

function UseNode({
  nodeKey: key,
  layout,
  consumer,
  loadKwh,
}: {
  nodeKey: UseNodeKey
  layout: ReturnType<typeof usageFlowLayout>
  consumer: Consumer | null
  loadKwh: number
}) {
  const n = layout.nodes[key]
  const t = usageNodeText(n, key, layout.narrow)
  const value = kwh(consumer ? consumer.kwh : loadKwh)
  const valueRef = useRef<SVGTextElement>(null)
  const size = useFittedSize(valueRef, value, t.value)
  const labelRef = useRef<SVGTextElement>(null)
  const label = useFittedText(
    labelRef,
    consumer ? consumer.label : m.energy_tile_load(),
    t.label.x,
    n.x + n.w / 2 - NODE_PADDING - t.label.x,
  )
  return (
    <NodeFrame
      data-flow-node={key}
      node={n}
      tile={t.tile}
      label={t.label}
      labelText={label}
      labelRef={labelRef}
      Icon={consumer ? consumer.Icon : HouseIcon}
      tint={consumer?.color}
    >
      {consumer ? (
        <text
          ref={valueRef}
          x={t.value.x}
          y={t.value.y}
          fontSize={14}
          style={NODE_MUTED}
          className="tabular-nums"
        >
          <tspan fontSize={size} fontWeight={600} className="fill-foreground">
            {value}
          </tspan>{' '}
          kWh · {consumer.share === null ? '—' : formatShare(consumer.share)}
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
    </NodeFrame>
  )
}
