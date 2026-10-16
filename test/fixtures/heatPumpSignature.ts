import type { SignatureDayRow } from '~/components/heatPump/EnergySignature'
import { addDays } from '~/lib/time/stockholm'

// Synthetic heat pump days for the signature's browser tests (step 4b), never real consumption.
// signatureUnitDays: Task 2's known data. 16 before-days (2026-01-04 … 01-19) on the line
// 2 + 0,5·ΔT ± 0,1, then 14 after-days (2026-01-21 … 02-03) at `afterShare` of the line:
// around a service on 2026-01-20, 0,9 gives change −0,1 and margin 0,784 ÷ 108,5.

export const signatureRow = (
  heatPumpId: string,
  day: string,
  deltaT: number,
  kwh: number,
): SignatureDayRow => ({
  heatPumpId,
  day,
  kwh,
  heatKwh: kwh,
  coolKwh: 0,
  insideC: 21,
  outsideC: 21 - deltaT,
  hours: 24,
  expectedHours: 24,
})

const NOISE = [0.1, -0.1, -0.1, 0.1]

export const signatureUnitDays = (
  heatPumpId: string,
  afterShare = 0.9,
  start = '2026-01-04',
): SignatureDayRow[] => [
  ...Array.from({ length: 16 }, (_, i) =>
    signatureRow(heatPumpId, addDays(start, i), 4 + i, 2 + 0.5 * (4 + i) + NOISE[i % 4]),
  ),
  ...Array.from({ length: 14 }, (_, i) =>
    signatureRow(heatPumpId, addDays(start, 17 + i), 5 + i, afterShare * (2 + 0.5 * (5 + i))),
  ),
]
