import { afterEach, expect, test, vi } from 'vitest'
import { logger } from '~/lib/logger/server'
import type { SessionEnergy } from '~/lib/services/evCharging'
import { mixSlot } from '~test/fixtures/energyMix'
import { MIX_GUARD_KWH, toIntervals } from './costInputs'

afterEach(() => {
  vi.restoreAllMocks()
})

const at = (iso: string) => Date.parse(iso)
const ZERO_MIX = {
  gridKwh: 0,
  solarKwh: 0,
  batteryGridKwh: 0,
  batteryGridSpotSek: null,
  batterySolarKwh: 0,
  batterySolarSpotSek: null,
  batteryUnpricedKwh: 0,
  noHouseDataKwh: 0,
}

function sessionOf(stretches: [string, string, number][]): SessionEnergy {
  return {
    sessionId: '00000000-0000-4000-8000-000000000001',
    startAt: new Date(stretches[0][0]),
    endAt: new Date(stretches[stretches.length - 1][1]),
    energyKwh: stretches.reduce((sum, [, , kwh]) => sum + kwh, 0),
    stretches: stretches.map(([s, e, kwh]) => ({ startMs: at(s), endMs: at(e), kwh })),
    estimated: false,
    vehicle: 'ours',
    vehicleSource: 'default',
  }
}

const S = sessionOf([['2026-09-28T08:00:00Z', '2026-09-28T08:30:00Z', 3]])
const MIX = [
  mixSlot('2026-09-28T08:00:00Z', { gridKwh: 1, solarKwh: 0.5 }),
  mixSlot('2026-09-28T08:15:00Z', { gridKwh: 0.5, batteryGridKwh: 1, batteryGridSpotSek: 0.4 }),
]

test('a matching mix becomes one 15-min piece per slot, priced per source', () => {
  expect(toIntervals(S, MIX)).toEqual([
    {
      startMs: at('2026-09-28T08:00:00Z'),
      endMs: at('2026-09-28T08:15:00Z'),
      kwh: 1.5,
      gridShare: 1,
      mix: { ...ZERO_MIX, gridKwh: 1, solarKwh: 0.5 },
    },
    {
      startMs: at('2026-09-28T08:15:00Z'),
      endMs: at('2026-09-28T08:30:00Z'),
      kwh: 1.5,
      gridShare: 1,
      mix: { ...ZERO_MIX, gridKwh: 0.5, batteryGridKwh: 1, batteryGridSpotSek: 0.4 },
    },
  ])
})

test('extra keys on a stored slot never reach the piece', () => {
  const withId = MIX.map((slot) => ({ ...slot, sessionId: S.sessionId }))
  expect(toIntervals(S, withId)[0].mix).toEqual({ ...ZERO_MIX, gridKwh: 1, solarKwh: 0.5 })
})

test('without a mix every stretch is bought from the grid, labelled as without house data', () => {
  const warn = vi.spyOn(logger, 'warn')
  const allGrid = [
    {
      startMs: at('2026-09-28T08:00:00Z'),
      endMs: at('2026-09-28T08:30:00Z'),
      kwh: 3,
      gridShare: 1,
      mix: { ...ZERO_MIX, noHouseDataKwh: 3 },
    },
  ]
  expect(toIntervals(S)).toEqual(allGrid)
  expect(toIntervals(S, [])).toEqual(allGrid)
  expect(warn).not.toHaveBeenCalled()
})

test('a mix that no longer matches the session is ignored with one warning', () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const stale = [...MIX, mixSlot('2026-09-28T08:30:00Z', { gridKwh: 0.25 })]
  const pieces = toIntervals(S, stale)
  expect(pieces).toHaveLength(1)
  expect(pieces[0].mix).toEqual({ ...ZERO_MIX, noHouseDataKwh: 3 })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith('cost: energy mix ignored, kWh differs from the session', {
    sessionId: S.sessionId,
    mixKwh: 3.25,
    energyKwh: 3,
  })
})

test('a drift within the guard keeps the mix; just past it does not', () => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const nudge = (d: number) => [
    MIX[0],
    { ...MIX[1], kwh: MIX[1].kwh + d, gridKwh: MIX[1].gridKwh + d },
  ]
  expect(toIntervals(S, nudge(MIX_GUARD_KWH / 2))).toHaveLength(2)
  expect(toIntervals(S, nudge(MIX_GUARD_KWH * 2))).toHaveLength(1)
})

test('the guard compares against the interval energy, not the session total', () => {
  // Zaptec's session total can differ slightly from its intervals; the mix is derived from the intervals.
  const s = { ...S, energyKwh: 3.4 }
  expect(toIntervals(s, MIX)).toHaveLength(2)
})
