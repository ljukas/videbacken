// src/components/heatPump/heatPumpView.test.ts
import { describe, expect, test } from 'vitest'
import { formatDay, monthLabel } from '~/components/evCharging/format'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { m } from '~/paraglide/messages'
import {
  allPayload,
  cell,
  daysPayload,
  MATSAL,
  monthsPayload,
  OVERVANING,
  span,
} from '~test/fixtures/heatPumpView'
import { heatPumpView, meanOutdoor } from './heatPumpView'

const NOW = { year: 2026, month: 9 }
const TODAY = '2026-09-15'
const view = (
  input: Partial<Parameters<typeof heatPumpView>[0]> &
    Pick<Parameters<typeof heatPumpView>[0], 'period'>,
) => heatPumpView({ months: monthsPayload(), days: null, now: NOW, today: TODAY, ...input })

describe('year view', () => {
  test('12 month rows: units stacked, the total, last year beside, selectable months with readings', () => {
    const v = view({ period: { kind: 'year', year: 2026 } })
    expect(v?.kind).toBe('year')
    expect(v?.rows).toHaveLength(12)
    const [jan] = v?.rows ?? []
    expect(jan).toMatchObject({
      key: '2026-01',
      label: monthLabel(1),
      short: monthLabel(1).charAt(0).toUpperCase(),
      month: { year: 2026, month: 1 },
      selectable: true,
      kwh: { [MATSAL.id]: 100, [OVERVANING.id]: 100 },
      total: 200,
      lastYear: 200,
      outdoorC: 2,
      missingHours: 0,
      running: false,
    })
    expect(v?.rows[8].running).toBe(true) // September 2026, the current month
    // October: nothing this year, last year's outline only, not selectable.
    expect(v?.rows[9]).toMatchObject({
      total: null,
      lastYear: 200,
      selectable: false,
      outdoorC: null,
    })
    expect(v?.chartLabel).toBe(m.heat_pump_chart_title_year({ year: '2026' }))
  })

  test("the outdoor temperature is hour-weighted over both units; missing hours are the worst unit's", () => {
    const p = monthsPayload()
    p.months = p.months.map((c) =>
      c.year === 2026 && c.month === 3
        ? c.heatPumpId === MATSAL.id
          ? { ...c, outsideC: 0, hours: 100, expectedHours: 744 }
          : { ...c, outsideC: 4, hours: 300, expectedHours: 744 }
        : c,
    )
    const mar = view({ months: p, period: { kind: 'year', year: 2026 } })?.rows[2]
    expect(mar?.outdoorC).toBeCloseTo(3, 9) // (0 × 100 + 4 × 300) ÷ 400
    expect(mar?.missingHours).toBe(644)
  })
})

describe('tiles', () => {
  test("a running year compares with last year up to the same hour, not with last year's whole newest month", () => {
    const p = monthsPayload()
    // Matsal 2025 January–August 125 kWh: base 8 × 125 + 50 (September so far) = 1050; 2026: 8 × 100 + 50 = 850.
    p.lastYear = p.lastYear.map((c) =>
      c.heatPumpId === MATSAL.id && c.month <= 8 ? { ...c, kwh: 125 } : c,
    )
    const t = view({ months: p, period: { kind: 'year', year: 2026 } })?.tiles
    const matsal = t?.units.find((u) => u.id === MATSAL.id)
    expect(matsal?.kwh).toBe(850)
    expect(matsal?.change).toBeCloseTo((850 - 1050) / 1050, 9)
    expect(t).toMatchObject({
      comparedWith: '2025',
      running: true,
      outdoorC: 2,
      missingHours: null,
    })
  })

  test('no change unless both periods have 99 % of their expected hours', () => {
    const p = monthsPayload()
    // Övervåning: 2025 base 7 × 720 + 600 + 300 of 8 × 720 + 360 expected = 97 %.
    p.lastYear = p.lastYear.map((c) =>
      c.heatPumpId === OVERVANING.id && c.month === 1 ? { ...c, hours: 600 } : c,
    )
    p.lastYearSoFar = (p.lastYearSoFar ?? []).map((c) =>
      c.heatPumpId === OVERVANING.id ? { ...c, hours: 300 } : c,
    )
    const t = view({ months: p, period: { kind: 'year', year: 2026 } })?.tiles
    expect(t?.units.find((u) => u.id === OVERVANING.id)?.change).toBeNull()
    expect(t?.units.find((u) => u.id === MATSAL.id)?.change).toBeCloseTo(0, 9)
  })

  test('a 48-hour stall in the running month hides the change for both units and names the gap', () => {
    const p = monthsPayload()
    // As the read model sends it: September so far 312 of 360 expected hours (a stall counts to `now`, Task 3), its
    // span 312 (it runs to the newest stored hour), and last year cut at that same hour: 312 of 312. Only the
    // expected-hours gate sees the stall.
    p.months = p.months.map((c) =>
      c.month === 9 ? { ...c, hours: 312, expectedHours: 360, spanHours: 312 } : c,
    )
    p.lastYearSoFar = (p.lastYearSoFar ?? []).map((c) => ({
      ...c,
      hours: 312,
      expectedHours: 312,
      spanHours: 312,
    }))
    const t = view({
      months: p,
      days: daysPayload(2026, 9, 13),
      period: { kind: 'month', year: 2026, month: 9 },
    })?.tiles
    expect(t?.units.map((u) => u.change)).toEqual([null, null])
    expect(t?.missingHours).toBe(48)
  })

  test('a past month compares with the same month a year earlier', () => {
    const p = monthsPayload()
    p.lastYear = p.lastYear.map((c) =>
      c.heatPumpId === MATSAL.id && c.month === 5 ? { ...c, kwh: 80 } : c,
    )
    const t = view({
      months: p,
      days: daysPayload(2026, 5, 31),
      period: { kind: 'month', year: 2026, month: 5 },
    })?.tiles
    expect(t?.units.find((u) => u.id === MATSAL.id)?.change).toBeCloseTo(0.25, 9)
    expect(t?.comparedWith).toBe(m.energy_period_month({ month: monthLabel(5), year: '2025' }))
    expect(t?.running).toBe(false)
  })

  test("the running month compares with last year's same month so far", () => {
    const p = monthsPayload()
    p.lastYearSoFar = (p.lastYearSoFar ?? []).map((c) =>
      c.heatPumpId === MATSAL.id ? { ...c, kwh: 40 } : c,
    )
    const t = view({
      months: p,
      days: daysPayload(2026, 9, 15),
      period: { kind: 'month', year: 2026, month: 9 },
    })?.tiles
    expect(t?.units.find((u) => u.id === MATSAL.id)?.change).toBeCloseTo(0.25, 9) // 50 vs 40
    expect(t?.running).toBe(true)
  })

  test('a unit without cells in the period: "no figure", no change; order and colours by byHeatPumpName', () => {
    const p = monthsPayload({ units: [OVERVANING, MATSAL] }) // the payload's order doesn't decide
    p.months = p.months.filter((c) => !(c.heatPumpId === OVERVANING.id && c.month === 5))
    const v = view({
      months: p,
      days: daysPayload(2026, 5, 31),
      period: { kind: 'month', year: 2026, month: 5 },
    })
    expect(v?.units.map((u) => u.name)).toEqual(['Matsal', 'Övervåning'])
    const t = v?.tiles
    expect(t?.units.map((u) => [u.name, u.color])).toEqual([
      ['Matsal', heatPumpColor([MATSAL, OVERVANING], MATSAL.id)],
      ['Övervåning', heatPumpColor([MATSAL, OVERVANING], OVERVANING.id)],
    ])
    expect(t?.units[0].color).not.toBe(t?.units[1].color)
    expect(t?.units[1]).toMatchObject({ kwh: null, change: null })
  })

  // Year 2025 read in September 2026: 2025 complete; 2024 is the units' first year (Matsal from 31 October, one day of
  // it; Övervåning from 27 November). Each of last year's cells is complete against its own expected hours.
  const firstYearPayload = () =>
    monthsPayload({
      year: 2025,
      months: [MATSAL, OVERVANING].flatMap((u) => span(1, 12).map((mo) => cell(u, 2025, mo))),
      lastYear: [
        cell(MATSAL, 2024, 10, { kwh: 3, hours: 24, expectedHours: 24, spanHours: 745 }),
        cell(MATSAL, 2024, 11),
        cell(MATSAL, 2024, 12),
        cell(OVERVANING, 2024, 11, { kwh: 12, hours: 96, expectedHours: 96 }),
        cell(OVERVANING, 2024, 12),
      ],
      lastYearSoFar: null,
    })

  test("a year against the units' first, partial year: no change (12 months aren't compared with 2)", () => {
    const t = view({ months: firstYearPayload(), period: { kind: 'year', year: 2025 } })?.tiles
    expect(t?.units.map((u) => [u.name, u.kwh, u.change])).toEqual([
      ['Matsal', 1200, null],
      ['Övervåning', 1200, null],
    ])
  })

  test("a month against the unit's first, partial month: no change; a whole month still compares", () => {
    const october = view({
      months: firstYearPayload(),
      days: daysPayload(2025, 10, 31),
      period: { kind: 'month', year: 2025, month: 10 },
    })?.tiles
    expect(october?.units.map((u) => u.change)).toEqual([null, null])
    const december = view({
      months: firstYearPayload(),
      days: daysPayload(2025, 12, 31),
      period: { kind: 'month', year: 2025, month: 12 },
    })?.tiles
    expect(december?.units.map((u) => u.change)).toEqual([0, 0])
  })

  test('a unit with cells this period but none last year: no change for it, the other unit keeps its own', () => {
    const p = monthsPayload()
    p.lastYear = p.lastYear.filter((c) => c.heatPumpId === MATSAL.id)
    p.lastYearSoFar = (p.lastYearSoFar ?? []).filter((c) => c.heatPumpId === MATSAL.id)
    const t = view({ months: p, period: { kind: 'year', year: 2026 } })?.tiles
    expect(t?.units.find((u) => u.id === OVERVANING.id)).toMatchObject({ kwh: 850, change: null })
    expect(t?.units.find((u) => u.id === MATSAL.id)?.change).toBeCloseTo(0, 9)
  })

  test('a unit removed in March: its January–March are complete to its end, but no change for the year', () => {
    const p = monthsPayload()
    p.months = p.months
      .filter((c) => c.heatPumpId !== OVERVANING.id || c.month <= 3)
      .map((c) =>
        c.heatPumpId === OVERVANING.id && c.month === 3
          ? { ...c, kwh: 40, hours: 300, expectedHours: 300 }
          : c,
      )
    const t = view({ months: p, period: { kind: 'year', year: 2026 } })?.tiles
    expect(t?.units.find((u) => u.id === OVERVANING.id)).toMatchObject({ kwh: 240, change: null })
    expect(t?.units.find((u) => u.id === MATSAL.id)?.change).toBeCloseTo(0, 9)
  })

  test("missing hours: the worst unit's, rounded; none when complete", () => {
    const p = monthsPayload()
    p.months = p.months.map((c) =>
      c.heatPumpId === MATSAL.id && c.month === 5 ? { ...c, hours: 700, expectedHours: 744 } : c,
    )
    expect(
      view({
        months: p,
        days: daysPayload(2026, 5, 31),
        period: { kind: 'month', year: 2026, month: 5 },
      })?.tiles.missingHours,
    ).toBe(44)
    expect(
      view({ days: daysPayload(2026, 5, 31), period: { kind: 'month', year: 2026, month: 5 } })
        ?.tiles.missingHours,
    ).toBeNull()
  })
})

describe('month view', () => {
  test('one row per day of the month, today running, no last year, not selectable', () => {
    const v = view({
      days: daysPayload(2026, 9, 15),
      period: { kind: 'month', year: 2026, month: 9 },
    })
    expect(v?.kind).toBe('month')
    expect(v?.rows).toHaveLength(30)
    expect(v?.rows[0]).toMatchObject({
      key: '2026-09-01',
      label: '1',
      title: formatDay('2026-09-01'),
      month: null,
      selectable: false,
      kwh: { [MATSAL.id]: 5, [OVERVANING.id]: 2 },
      total: 7,
      lastYear: null,
      outdoorC: 3,
    })
    expect(v?.rows[14].running).toBe(true)
    expect(v?.rows[15]).toMatchObject({ total: null, outdoorC: null, running: false })
  })
})

describe('Totalt', () => {
  test('one row per month of the history, no comparison', () => {
    const v = view({ months: allPayload(), period: { kind: 'all' } })
    expect(v?.rows).toHaveLength(21) // 2025-01 … 2026-09
    expect(v?.rows[0]).toMatchObject({
      key: '2025-01',
      label: m.energy_period_month({ month: monthLabel(1), year: '2025' }),
      selectable: true,
      lastYear: null,
    })
    expect(v?.tiles.comparedWith).toBeNull()
    expect(v?.tiles.units.every((u) => u.change === null)).toBe(true)
    expect(v?.periodLabel).toBe(m.charging_tile_all_time())
  })
})

test('reads that do not match the period give no view', () => {
  expect(view({ period: { kind: 'year', year: 2025 } })).toBeNull() // payload is 2026
  expect(view({ period: { kind: 'month', year: 2026, month: 9 } })).toBeNull() // no days yet
  expect(view({ period: { kind: 'all' } })).toBeNull() // a year payload
  expect(view({ months: allPayload(), period: { kind: 'year', year: 2026 } })).toBeNull()
})

test('meanOutdoor skips cells without a value or without hours', () => {
  expect(
    meanOutdoor([
      cell(MATSAL, 2026, 1, { outsideC: null }),
      cell(MATSAL, 2026, 2, { outsideC: 10, hours: 0 }),
      cell(OVERVANING, 2026, 1, { outsideC: -1, hours: 10 }),
    ]),
  ).toBeCloseTo(-1, 9)
  expect(meanOutdoor([])).toBeNull()
  expect(span(1, 3)).toEqual([1, 2, 3])
})
