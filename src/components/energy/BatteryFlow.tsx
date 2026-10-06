import { useParentSize } from '@visx/responsive'
import {
  formatOneDecimal,
  formatShare,
  formatSignedOneDecimal,
} from '~/components/evCharging/format'
import { useLocalStorageFlag } from '~/hooks/useLocalStorageFlag'
import {
  type EnergyFigures,
  energyFigures,
  gapHours,
  type PeriodSums,
} from '~/lib/houseEnergy/figures'
import { MIN_FLOW_KWH } from '~/lib/houseEnergy/flowLayout'
import { m } from '~/paraglide/messages'
import { BatteryFlowDiagram } from './BatteryFlowDiagram'
import { SHOW_FLOW_VALUES_KEY } from './EnergyFlow'
import { FlowTableFrame, FlowValuesSwitch, RingFigure } from './flowParts'

/** "—" without a value, "≈ 100 %" when capped at 1, else the share. */
export function efficiencyText(e: number | null): string {
  if (e === null) return '—'
  return e >= 1 ? `≈ ${formatShare(1)}` : formatShare(e)
}

// The Batteri page's Summering card body (step 2): Verkningsgrad, the battery flow in a box whose height is
// reserved per layout by a container query (content 860 px wide → 300 px, else 430 px), the values switch
// (Översikt's preference), the gap note and the table.
export function BatteryFlow({ sums }: { sums: PeriodSums | null | 'unavailable' }) {
  const [showValues, setShowValues] = useLocalStorageFlag(SHOW_FLOW_VALUES_KEY, true)
  const { parentRef, width } = useParentSize({ debounceTime: 50 })
  const s = sums && sums !== 'unavailable' ? sums : null
  const f = s ? energyFigures(s) : null
  const gap = f ? gapHours(f) : null
  return (
    <div className="@container flex flex-col gap-3">
      <RingFigure
        value={f?.efficiency ?? null}
        valueText={efficiencyText(f?.efficiency ?? null)}
        label={m.energy_battery_efficiency()}
        detail={m.energy_battery_efficiency_detail()}
        arcClassName="stroke-energy-battery"
        hidden={!f}
      />
      <div
        ref={parentRef}
        data-slot="energy-flow-box"
        className="relative h-[430px] w-full @[860px]:h-[300px]"
      >
        {s && f && width > 0 ? (
          <BatteryFlowDiagram sums={s} figures={f} width={width} showValues={showValues} />
        ) : null}
        {sums === null ? (
          <p className="absolute top-0 left-0 text-muted-foreground text-sm">
            {m.energy_period_no_data()}
          </p>
        ) : null}
      </div>
      <FlowValuesSwitch
        checked={showValues}
        onCheckedChange={setShowValues}
        hint={m.energy_flow_hint()}
      />
      <p
        data-slot="energy-gap"
        className="min-h-[1.5em] text-muted-foreground text-sm leading-normal"
      >
        {gap === null ? null : m.energy_missing_hours({ hours: String(gap) })}
      </p>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {m.energy_flow_table_toggle()}
        </summary>
        {s && f ? <BatteryTable sums={s} f={f} /> : null}
      </details>
    </div>
  )
}

function BatteryTable({ sums: s, f }: { sums: PeriodSums; f: EnergyFigures }) {
  const socKnown = s.firstSocPct !== null && s.lastSocPct !== null
  const kwh = (v: number) => `${formatOneDecimal(v)} kWh`
  const rows: [string, string][] = [
    [m.energy_battery_row_in_solar(), kwh(f.solarToBattery)],
    [m.energy_battery_row_in_grid(), kwh(f.batteryIn - f.solarToBattery)],
    [m.energy_battery_row_in_total(), kwh(f.batteryIn)],
    [
      m.energy_flow_row_stored(),
      socKnown ? `${formatSignedOneDecimal(f.deltaStored)}\u00a0kWh` : '—',
    ],
    [m.energy_battery_node_out(), kwh(f.batteryOut)],
    ...(f.batteryToGrid >= MIN_FLOW_KWH
      ? ([[m.energy_battery_row_sold(), kwh(f.batteryToGrid)]] as [string, string][])
      : []),
    // The real value, also when the diagram says "≈ 0".
    [
      m.energy_flow_loss_title(),
      f.lossShare === null ? kwh(f.loss) : `${kwh(f.loss)} (${formatShare(f.lossShare)})`,
    ],
    [m.energy_battery_efficiency(), efficiencyText(f.efficiency)],
  ]
  const charge = socKnown
    ? m.energy_flow_charge_level({
        from: String(Math.round(s.firstSocPct as number)),
        to: String(Math.round(s.lastSocPct as number)),
      })
    : null
  return (
    <FlowTableFrame rows={rows}>
      {charge ? (
        <tr className="border-b">
          <th scope="row" colSpan={2} className="py-1.5 text-left font-normal">
            {charge}
          </th>
        </tr>
      ) : null}
    </FlowTableFrame>
  )
}
