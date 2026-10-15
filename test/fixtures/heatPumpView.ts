// test/fixtures/heatPumpView.ts
// Synthetic `heatPump.months` / `heatPump.days` payloads (heat pumps step 3). Never the owner's figures.
import type { HeatPumpDaysOutput, HeatPumpMonthCell, HeatPumpMonths } from '~/lib/services/heatPump'

export const MATSAL = { id: '00000000-0000-4000-8000-000000000001', name: 'Matsal' }
export const OVERVANING = { id: '00000000-0000-4000-8000-000000000002', name: 'Övervåning' }
const UNITS = [MATSAL, OVERVANING]
const pad = (n: number) => String(n).padStart(2, '0')
export const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

/** A complete month cell: 100 kWh, all heating, 2 °C outside, 720 of 720 hours, unless overridden. */
export const cell = (
  unit: { id: string },
  year: number,
  month: number,
  over: Partial<HeatPumpMonthCell> = {},
): HeatPumpMonthCell => ({
  heatPumpId: unit.id,
  year,
  month,
  kwh: 100,
  heatKwh: 100,
  coolKwh: 0,
  outsideC: 2,
  hours: 720,
  expectedHours: 720,
  ...over,
})

/**
 * The year 2026 read on 2026-09-15: both units, 2025 complete, 2026 up to September (the newest month, half done:
 * 50 kWh in 360 of 360 hours so far), and September 2025 cut at the same hour (50 kWh, 360 h).
 */
export function monthsPayload(over: Partial<HeatPumpMonths> = {}): HeatPumpMonths {
  return {
    units: UNITS,
    year: 2026,
    availableYears: [2026, 2025],
    firstReadingDay: '2025-01-01',
    monthsWithReadings: [
      ...span(1, 12).map((mo) => `2025-${pad(mo)}`),
      ...span(1, 9).map((mo) => `2026-${pad(mo)}`),
    ],
    newestMonth: '2026-09',
    months: UNITS.flatMap((u) => [
      ...span(1, 8).map((mo) => cell(u, 2026, mo)),
      cell(u, 2026, 9, { kwh: 50, hours: 360, expectedHours: 360 }),
    ]),
    lastYear: UNITS.flatMap((u) => span(1, 12).map((mo) => cell(u, 2025, mo))),
    lastYearSoFar: UNITS.map((u) => cell(u, 2025, 9, { kwh: 50, hours: 360, expectedHours: 360 })),
    ...over,
  }
}

/** Totalt: every month 2025-01 … 2026-09 of both units in `months`, no last year. */
export function allPayload(): HeatPumpMonths {
  const year = monthsPayload()
  return monthsPayload({
    year: null,
    months: [...year.lastYear, ...year.months],
    lastYear: [],
    lastYearSoFar: null,
  })
}

/** Days 1 … `withData` of a month: Matsal 5 kWh, Övervåning 2 kWh a day, 3 °C outside, 24 of 24 hours. */
export function daysPayload(year: number, month: number, withData: number): HeatPumpDaysOutput {
  const days = span(1, withData).map((d) => `${year}-${pad(month)}-${pad(d)}`)
  return {
    units: UNITS,
    days: UNITS.flatMap((u, i) =>
      days.map((day) => ({
        heatPumpId: u.id,
        day,
        kwh: i === 0 ? 5 : 2,
        heatKwh: i === 0 ? 5 : 2,
        coolKwh: 0,
        insideC: 21,
        outsideC: 3,
        setpointC: 21,
        hours: 24,
        expectedHours: 24,
      })),
    ),
  }
}
