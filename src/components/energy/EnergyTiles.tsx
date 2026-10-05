import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  GaugeIcon,
  HouseIcon,
  SunIcon,
} from 'lucide-react'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import { Readout } from '~/components/evCharging/TotalsTiles'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { type EnergyTilesData, PeriodTabs } from './PeriodTabs'

export type { EnergyTilesData } from './PeriodTabs'

// The house's energy per period: solar and where it went, bought, sold,
// self-sufficiency and consumption with the car's part (ADR-0024).
export function EnergyTiles({ tiles }: { tiles: EnergyTilesData }) {
  return <PeriodTabs tiles={tiles}>{(sums) => <PeriodReadouts sums={sums} />}</PeriodTabs>
}

const kwh = (value: number) => formatOneDecimal(value)

function PeriodReadouts({ sums }: { sums: PeriodSums }) {
  const f = energyFigures(sums)
  const gap = gapHours(f)
  // Normalised so an overshoot (more solar into the battery than was produced)
  // never reads above 100 %; in the normal case the denominator is solarKwh.
  const splitTotal = Math.max(sums.solarKwh, f.solarDirect + f.solarToBattery + f.solarExported)
  const share = (part: number) => formatShare(part / splitTotal)
  return (
    <div className="@container flex flex-col gap-3">
      <div className="grid @4xl:grid-cols-5 @sm:grid-cols-2 gap-4">
        <Readout
          icon={SunIcon}
          label={m.energy_tile_solar()}
          value={kwh(sums.solarKwh)}
          unit="kWh"
          detail={
            sums.solarKwh > 0
              ? m.energy_tile_solar_split({
                  direct: share(f.solarDirect),
                  battery: share(f.solarToBattery),
                  exported: share(f.solarExported),
                })
              : undefined
          }
        />
        <Readout
          icon={ArrowDownToLineIcon}
          label={m.energy_tile_import()}
          value={kwh(sums.gridImportKwh)}
          unit="kWh"
          detail={
            f.importToBattery > 0
              ? m.energy_tile_import_to_battery({ kwh: kwh(f.importToBattery) })
              : undefined
          }
        />
        <Readout
          icon={ArrowUpFromLineIcon}
          label={m.energy_tile_export()}
          value={kwh(sums.gridExportKwh)}
          unit="kWh"
        />
        <Readout
          icon={GaugeIcon}
          label={m.energy_tile_self_sufficiency()}
          value={f.selfSufficiency === null ? '—' : formatShare(f.selfSufficiency)}
          muted={f.selfSufficiency === null}
          detail={f.selfSufficiency === null ? undefined : m.energy_tile_self_sufficiency_detail()}
        />
        <Readout
          icon={HouseIcon}
          label={m.energy_tile_load()}
          value={kwh(sums.loadKwh)}
          unit="kWh"
          detail={f.car > 0 ? m.energy_tile_load_car({ kwh: kwh(f.car) }) : undefined}
        />
      </div>
      {gap === null ? null : (
        <p className="text-muted-foreground text-xs">
          {m.energy_missing_hours({ hours: String(gap) })}
        </p>
      )}
    </div>
  )
}
