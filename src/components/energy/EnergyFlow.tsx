import { useParentSize } from '@visx/responsive'
import { useId } from 'react'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import { Switch } from '~/components/ui/switch'
import { useLocalStorageFlag } from '~/hooks/useLocalStorageFlag'
import {
  type EnergyFigures,
  energyFigures,
  gapHours,
  type PeriodSums,
} from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { EnergyFlowDiagram } from './EnergyFlowDiagram'

export const SHOW_FLOW_VALUES_KEY = 'videbacken-energy-flow-values'

// The Summering card's body (step 1c, spec "The card"): Självförsörjning, the flow diagram in a box whose height
// is reserved per layout by a container query (content 860 px wide → 360 px, else 490 px) so nothing shifts before
// it is measured or when the period changes, the values switch, the gap note and the table.
export function EnergyFlow({ sums }: { sums: PeriodSums | null | 'unavailable' }) {
  const [showValues, setShowValues] = useLocalStorageFlag(SHOW_FLOW_VALUES_KEY, true)
  const { parentRef, width } = useParentSize({ debounceTime: 50 })
  const switchId = useId()
  const s = sums && sums !== 'unavailable' ? sums : null
  const f = s ? energyFigures(s) : null
  const gap = f ? gapHours(f) : null
  return (
    <div className="@container flex flex-col gap-3">
      <SelfSufficiency value={f?.selfSufficiency ?? null} hidden={!f} />
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
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-muted-foreground text-sm">{m.energy_flow_hint()}</p>
        <label
          htmlFor={switchId}
          className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm"
        >
          <Switch id={switchId} checked={showValues} onCheckedChange={setShowValues} />
          {m.energy_flow_show_values()}
        </label>
      </div>
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

function SelfSufficiency({ value, hidden }: { value: number | null; hidden: boolean }) {
  const r = 18
  const circ = 2 * Math.PI * r
  return (
    // Invisible (not absent) without figures, so the card is as tall for every period.
    <div
      className={hidden ? 'invisible flex items-center gap-3' : 'flex items-center gap-3'}
      aria-hidden={hidden || undefined}
    >
      <svg viewBox="0 0 44 44" className="size-11 shrink-0" aria-hidden="true">
        <circle cx={22} cy={22} r={r} fill="none" strokeWidth={6} className="stroke-muted" />
        {value !== null ? (
          <circle
            cx={22}
            cy={22}
            r={r}
            fill="none"
            strokeWidth={6}
            className="stroke-foreground"
            strokeDasharray={`${circ * value} ${circ}`}
            transform="rotate(-90 22 22)"
          />
        ) : null}
      </svg>
      <div className="flex flex-col">
        <span className="font-medium text-sm">{m.energy_tile_self_sufficiency()}</span>
        <span className="font-semibold text-[length:24px] tabular-nums leading-tight @[860px]:text-[length:28px]">
          {value === null ? '—' : formatShare(value)}
        </span>
        <span className="text-muted-foreground text-sm">
          {m.energy_tile_self_sufficiency_detail()}
        </span>
      </div>
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
    [m.energy_flow_row_stored(), kwh(f.deltaStored)],
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
    <div className="mt-2 overflow-x-auto">
      <table className="min-w-full border-collapse">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1.5 pr-4 font-medium">
              {m.energy_flow_table_flow()}
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              {m.energy_flow_table_value()}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value]) => (
            <tr key={name} className="border-b">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                {name}
              </th>
              <td className="py-1.5 text-right tabular-nums">{value}</td>
            </tr>
          ))}
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
        </tbody>
      </table>
    </div>
  )
}
