import { expect, test } from 'vitest'
import { emptyTotals } from '~/lib/evCharging/cost'
import { toEconomyListRow } from './listRow'
import type { SessionEconomy } from './types'

const session = {
  sessionId: 's1',
  startAt: new Date('2026-09-05T19:10:00Z'),
  endAt: new Date('2026-09-06T05:02:00Z'),
  energyKwh: 32.1,
  vehicle: 'ours' as const,
}
const totals = (totalSek: number) => ({
  ...emptyTotals(),
  kwh: 10,
  gridKwh: 10,
  fullKwh: 10,
  totalSek,
})
const base = { paidSpotOre: 40, windowAvgSpotOre: 55 }

test('a compared session keeps the four figures the table shows, and the spread', () => {
  const economy: SessionEconomy = {
    ...base,
    actual: totals(41.2),
    actualComplete: true,
    excluded: null,
    counterfactual: {
      immediate: totals(53.6),
      optimal: totals(38),
      dearest: totals(70),
      score: 0.9,
      savedVsImmediateSek: 12.4,
      leftOnTableSek: 3.2,
    },
  }
  expect(toEconomyListRow(session, economy)).toEqual({
    sessionId: 's1',
    startAt: session.startAt,
    endAt: session.endAt,
    vehicle: 'ours',
    kwh: 32.1,
    actualSek: 41.2,
    excluded: null,
    counterfactual: { savedVsImmediateSek: 12.4, leftOnTableSek: 3.2, score: 0.9, spreadSek: 32 },
  })
})

test('an incomplete actual is null, never partial kronor', () => {
  const economy: SessionEconomy = {
    ...base,
    actual: totals(17.5),
    actualComplete: false,
    excluded: 'no_price',
    counterfactual: null,
  }
  expect(toEconomyListRow(session, economy)).toMatchObject({
    actualSek: null,
    excluded: 'no_price',
    counterfactual: null,
  })
})

test('an excluded no_hourly session keeps its complete (estimated) actual', () => {
  const economy: SessionEconomy = {
    ...base,
    actual: totals(20),
    actualComplete: true,
    excluded: 'no_hourly',
    counterfactual: null,
  }
  expect(toEconomyListRow(session, economy)).toMatchObject({ actualSek: 20, excluded: 'no_hourly' })
})
