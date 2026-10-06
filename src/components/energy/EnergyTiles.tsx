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

// The house's energy for one period: solar and where it went, bought, sold,
// self-sufficiency and consumption with the car's part (ADR-0024). The page
// owns the card and the period control. `null`: the period has no readings
// (said so); `'unavailable'`: its figures couldn't be read (blank, the page's
// alert explains; "no data" would be a false empty claim, ADR-0016).
export function EnergyReadouts({ sums }: { sums: PeriodSums | null | 'unavailable' }) {
  return (
    <div className="@container flex flex-col gap-3">
      {sums && sums !== 'unavailable' ? (
        <PeriodReadouts sums={sums} />
      ) : (
        // The same grid, invisible, so the empty state is exactly as tall as a full one at any width.
        <div className="relative">
          <div aria-hidden className="invisible flex flex-col gap-3">
            <PeriodReadouts sums={EMPTY_SUMS} />
          </div>
          {sums === null ? (
            <p className="absolute top-0 left-0 text-muted-foreground text-sm">
              {m.energy_period_no_data()}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

const EMPTY_SUMS: PeriodSums = {
  gridImportKwh: 0,
  gridExportKwh: 0,
  solarKwh: 0,
  loadKwh: 0,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  carKwh: 0,
  firstSocPct: null,
  lastSocPct: null,
  buckets: 0,
  expectedBuckets: 0,
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
    <>
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 @[35rem]:grid-cols-3 @[61.25rem]:grid-cols-5">
        <Readout
          size="lg"
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
          size="lg"
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
          size="lg"
          icon={ArrowUpFromLineIcon}
          label={m.energy_tile_export()}
          value={kwh(sums.gridExportKwh)}
          unit="kWh"
        />
        <Readout
          size="lg"
          icon={GaugeIcon}
          label={m.energy_tile_self_sufficiency()}
          value={f.selfSufficiency === null ? '—' : formatShare(f.selfSufficiency)}
          muted={f.selfSufficiency === null}
          detail={f.selfSufficiency === null ? undefined : m.energy_tile_self_sufficiency_detail()}
        />
        <Readout
          size="lg"
          icon={HouseIcon}
          label={m.energy_tile_load()}
          value={kwh(sums.loadKwh)}
          unit="kWh"
          detail={f.car > 0 ? m.energy_tile_load_car({ kwh: kwh(f.car) }) : undefined}
        />
      </div>
      <p
        data-slot="energy-gap"
        className="min-h-[1.5em] text-muted-foreground text-sm leading-normal"
      >
        {gap === null ? null : m.energy_missing_hours({ hours: String(gap) })}
      </p>
    </>
  )
}
