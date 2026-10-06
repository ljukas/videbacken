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
import { m } from '~/paraglide/messages'
import { EnergyFlowDiagram } from './EnergyFlowDiagram'
import { FlowTableFrame, FlowValuesSwitch, RingFigure } from './flowParts'

export const SHOW_FLOW_VALUES_KEY = 'videbacken-energy-flow-values'

// The Summering card's body (step 1c, spec "The card"): Självförsörjning, the flow diagram in a box whose height
// is reserved per layout by a container query (content 860 px wide → 360 px, else 490 px) so nothing shifts before
// it is measured or when the period changes, the values switch, the gap note and the table.
export function EnergyFlow({ sums }: { sums: PeriodSums | null | 'unavailable' }) {
  const [showValues, setShowValues] = useLocalStorageFlag(SHOW_FLOW_VALUES_KEY, true)
  const { parentRef, width } = useParentSize({ debounceTime: 50 })
  const s = sums && sums !== 'unavailable' ? sums : null
  const f = s ? energyFigures(s) : null
  const gap = f ? gapHours(f) : null
  return (
    <div className="@container flex flex-col gap-3">
      <RingFigure
        value={f?.selfSufficiency ?? null}
        label={m.energy_tile_self_sufficiency()}
        detail={m.energy_tile_self_sufficiency_detail()}
        arcClassName="stroke-foreground"
        hidden={!f}
      />
      <div
        ref={parentRef}
        data-slot="energy-flow-box"
        className="relative h-[490px] w-full @[860px]:h-[360px]"
      >
        {s && f && width > 0 ? (
          <EnergyFlowDiagram sums={s} figures={f} width={width} showValues={showValues} />
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
        {s && f ? <FlowTable sums={s} f={f} /> : null}
      </details>
    </div>
  )
}

function FlowTable({ sums: s, f }: { sums: PeriodSums; f: EnergyFigures }) {
  const solar = m.energy_tile_solar()
  const imp = m.energy_tile_import()
  const bat = m.energy_flow_battery()
  const load = m.energy_tile_load()
  const exp = m.energy_tile_export()
  const arrow = (from: string, to: string) => m.energy_flow_arrow({ from, to })
  const kwh = (v: number) => `${formatOneDecimal(v)}\u00a0kWh`
  const rows: [string, string][] = [
    [solar, kwh(s.solarKwh)],
    [imp, kwh(s.gridImportKwh)],
    [exp, kwh(s.gridExportKwh)],
    [load, kwh(s.loadKwh)],
    [m.energy_flow_car(), kwh(f.car)],
    [arrow(solar, load), kwh(f.solarDirect)],
    [arrow(solar, bat), kwh(f.solarToBattery)],
    [arrow(solar, exp), kwh(f.solarExported)],
    [arrow(imp, load), kwh(f.importDirect)],
    [arrow(imp, bat), kwh(f.importToBattery)],
    [arrow(bat, load), kwh(f.batteryToHouse)],
    [arrow(bat, exp), kwh(f.batteryToGrid)],
    [m.energy_flow_row_battery_in(), kwh(f.batteryIn)],
    [m.energy_flow_row_battery_out(), kwh(f.batteryOut)],
    // Signed like the diagram's "Lager" line.
    [m.energy_flow_row_stored(), `${formatSignedOneDecimal(f.deltaStored)}\u00a0kWh`],
    // The real value, also when the diagram says "≈ 0".
    [m.energy_flow_loss_title(), kwh(f.loss)],
  ]
  const charge =
    s.firstSocPct !== null && s.lastSocPct !== null
      ? m.energy_flow_charge_level({
          from: String(Math.round(s.firstSocPct)),
          to: String(Math.round(s.lastSocPct)),
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
      <tr>
        <th scope="row" className="py-1.5 pr-4 text-left font-normal">
          {m.energy_tile_self_sufficiency()}
        </th>
        <td className="py-1.5 text-right tabular-nums">
          {f.selfSufficiency === null ? '—' : formatShare(f.selfSufficiency)}
        </td>
      </tr>
    </FlowTableFrame>
  )
}
