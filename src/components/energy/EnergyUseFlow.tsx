import { useParentSize } from '@visx/responsive'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import { useLocalStorageFlag } from '~/hooks/useLocalStorageFlag'
import { type EnergyFigures, energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { SHOW_FLOW_VALUES_KEY } from './EnergyFlow'
import { EnergyUseFlowDiagram } from './EnergyUseFlowDiagram'
import { FlowTableFrame, FlowValuesSwitch } from './flowParts'

// The Användning card's body (heat pumps step 2, spec "Energi › Översikt: Användning"): the diagram in a box whose
// height is reserved per layout by a container query (content 860 px wide → 312 px, else 436 px) whatever the number
// of consumers, the values switch (Summering's preference; wide only, where the values sit on the arrows), the missing
// heat pump hours note on a reserved line, and the table.
export function EnergyUseFlow({
  sums,
  units,
}: {
  sums: PeriodSums | null | 'unavailable'
  /** Every unit in its all-time order: the colour order. */
  units: readonly { id: string; name: string }[]
}) {
  const [showValues, setShowValues] = useLocalStorageFlag(SHOW_FLOW_VALUES_KEY, true)
  const { parentRef, width } = useParentSize({ debounceTime: 50 })
  const s = sums && sums !== 'unavailable' ? sums : null
  const f = s ? energyFigures(s) : null
  const missing = f && f.heatPumpMissingHours >= 1 ? f.heatPumpMissingHours : null
  return (
    <div className="@container flex flex-col gap-3">
      <div
        ref={parentRef}
        data-slot="energy-use-box"
        className="relative h-[436px] w-full @[860px]:h-[312px]"
      >
        {s && f && width > 0 ? (
          <EnergyUseFlowDiagram
            sums={s}
            figures={f}
            units={units}
            width={width}
            showValues={showValues}
          />
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
        hint={m.energy_use_hint()}
        switchClassName="hidden @[860px]:flex"
      />
      {/* Övrigt hus is overstated by the missing hours' heat pump use; Summering's own gap note stays in Summering. */}
      <p
        data-slot="energy-use-gap"
        className="min-h-[1.5em] text-muted-foreground text-sm leading-normal"
      >
        {missing === null ? null : m.energy_use_missing_hours({ hours: String(missing) })}
      </p>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {m.energy_flow_table_toggle()}
        </summary>
        {s && f ? <UseTable sums={s} f={f} /> : null}
      </details>
    </div>
  )
}

function UseTable({ sums: s, f }: { sums: PeriodSums; f: EnergyFigures }) {
  const kwh = (v: number) => `${formatOneDecimal(v)} kWh`
  const share = (v: number) => (s.loadKwh > 0 ? formatShare(v / s.loadKwh) : '—')
  const rows: string[][] = [
    [m.energy_series_car(), kwh(f.car), share(f.car)],
    ...f.heatPumps.map((u) => [
      m.energy_heat_pump_name({ name: u.name }),
      kwh(u.kwh),
      share(u.kwh),
    ]),
    [m.energy_use_house(), kwh(f.restOfHouse), share(f.restOfHouse)],
    [m.energy_tile_load(), kwh(s.loadKwh), s.loadKwh > 0 ? formatShare(1) : '—'],
  ]
  return (
    <FlowTableFrame
      columns={[
        m.energy_use_table_consumer(),
        m.energy_use_table_energy(),
        m.energy_use_table_share(),
      ]}
      rows={rows}
    />
  )
}
