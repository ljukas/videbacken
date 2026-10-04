import type { PieceMix } from '~/lib/evCharging/cost'
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'

const ZERO: PieceMix = {
  gridKwh: 0,
  solarKwh: 0,
  batteryGridKwh: 0,
  batteryGridSpotSek: null,
  batterySolarKwh: 0,
  batterySolarSpotSek: null,
  batteryUnpricedKwh: 0,
  noHouseDataKwh: 0,
}

/**
 * A synthetic stored mix slot (never real readings — the repo is public).
 * `kwh` is the sum of the parts, as the table's CHECK requires.
 */
export function mixSlot(slotStartIso: string, parts: Partial<PieceMix>): MixSlot {
  const p = { ...ZERO, ...parts }
  return {
    slotStart: new Date(slotStartIso),
    kwh:
      p.gridKwh +
      p.solarKwh +
      p.batteryGridKwh +
      p.batterySolarKwh +
      p.batteryUnpricedKwh +
      p.noHouseDataKwh,
    ...p,
  }
}
