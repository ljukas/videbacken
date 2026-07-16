import { expect, test } from 'vitest'
import { DEFAULT_YEAR_ROTATION, rotateShare, WEEKS_PER_SEASON } from '~/lib/shares/codes'
import { ANCHOR_ERA } from '~test/fixtures/season'
import {
  buildSchedules,
  eraForYear,
  monthBandsForRange,
  monthBandsForSeason,
  monthForISOWeek,
  type SeasonEra,
  seasonForYear,
  shareBlocksForSeason,
  startShareForYear,
} from './logic'

test('shareBlocksForSeason reproduces the 2026 row from the Disponeringslista', () => {
  const blocks = shareBlocksForSeason({ startWeek: 21, startShare: 'D' })
  expect(blocks).toEqual([
    { firstWeek: 21, lastWeek: 22, shareCode: 'D' },
    { firstWeek: 23, lastWeek: 24, shareCode: 'E' },
    { firstWeek: 25, lastWeek: 26, shareCode: 'F' },
    { firstWeek: 27, lastWeek: 28, shareCode: 'G' },
    { firstWeek: 29, lastWeek: 30, shareCode: 'H' },
    { firstWeek: 31, lastWeek: 32, shareCode: 'I' },
    { firstWeek: 33, lastWeek: 34, shareCode: 'J' },
    { firstWeek: 35, lastWeek: 36, shareCode: 'A' },
    { firstWeek: 37, lastWeek: 38, shareCode: 'B' },
    { firstWeek: 39, lastWeek: 40, shareCode: 'C' },
  ])
})

test('default year rotation slips every share 6 weeks (ADR-0018)', () => {
  // Year 1: startShare A → share A owns weeks 21–22.
  const y1 = shareBlocksForSeason({ startWeek: 21, startShare: 'A' })
  expect(y1.find((b) => b.shareCode === 'A')).toEqual({
    firstWeek: 21,
    lastWeek: 22,
    shareCode: 'A',
  })

  // Year 2 via the default rotation: A slips to weeks 27/28.
  const startShare = rotateShare('A', DEFAULT_YEAR_ROTATION)
  expect(startShare).toBe('H')
  const y2 = shareBlocksForSeason({ startWeek: 21, startShare })
  expect(y2.find((b) => b.shareCode === 'A')).toEqual({
    firstWeek: 27,
    lastWeek: 28,
    shareCode: 'A',
  })
})

test('monthForISOWeek follows the ISO Thursday-month rule', () => {
  // 2026 — Thursday of W21 is May 21 → Maj.
  expect(monthForISOWeek(2026, 21)).toBe(4)
  expect(monthForISOWeek(2026, 22)).toBe(4)
  // W23 of 2026: Thu Jun 4 → Jun.
  expect(monthForISOWeek(2026, 23)).toBe(5)
  // W40 of 2026: Thu Oct 1 → Okt.
  expect(monthForISOWeek(2026, 40)).toBe(9)

  // 2027 — boundary case: W22 has Mon May 31 / Thu Jun 3 → Jun.
  expect(monthForISOWeek(2027, 22)).toBe(5)
  // W21 of 2027: Thu May 27 → Maj.
  expect(monthForISOWeek(2027, 21)).toBe(4)
})

test('monthBandsForSeason produces the 2026 split 2/4/5/4/4/1 across Maj..Okt', () => {
  const bands = monthBandsForSeason({ year: 2026, startWeek: 21 })
  expect(bands).toEqual([
    { month: 4, firstWeek: 21, lastWeek: 22, span: 2 },
    { month: 5, firstWeek: 23, lastWeek: 26, span: 4 },
    { month: 6, firstWeek: 27, lastWeek: 31, span: 5 },
    { month: 7, firstWeek: 32, lastWeek: 35, span: 4 },
    { month: 8, firstWeek: 36, lastWeek: 39, span: 4 },
    { month: 9, firstWeek: 40, lastWeek: 40, span: 1 },
  ])
})

test('monthBandsForSeason for 2027 (startWeek=20) covers Maj..Sep with no October overflow', () => {
  // Logic check: a non-21 era start week (weeks 20..39) stays inside September.
  const bands = monthBandsForSeason({ year: 2027, startWeek: 20 })
  expect(bands).toEqual([
    { month: 4, firstWeek: 20, lastWeek: 21, span: 2 },
    { month: 5, firstWeek: 22, lastWeek: 25, span: 4 },
    { month: 6, firstWeek: 26, lastWeek: 30, span: 5 },
    { month: 7, firstWeek: 31, lastWeek: 34, span: 4 },
    { month: 8, firstWeek: 35, lastWeek: 39, span: 5 },
  ])
})

test('eraForYear picks the era with the greatest fromYear <= year', () => {
  const later: SeasonEra = { fromYear: 2028, startWeek: 22, startShare: 'D' }
  const eras = [ANCHOR_ERA, later]
  expect(eraForYear(eras, 2023)).toBeNull()
  expect(eraForYear(eras, 2024)).toBe(ANCHOR_ERA)
  expect(eraForYear(eras, 2027)).toBe(ANCHOR_ERA)
  expect(eraForYear(eras, 2028)).toBe(later)
  expect(eraForYear(eras, 2031)).toBe(later)
  // Order-independent: same answers with the array reversed.
  expect(eraForYear([later, ANCHOR_ERA], 2027)).toBe(ANCHOR_ERA)
})

test('startShareForYear rotates -3 per year from the era anchor', () => {
  expect(startShareForYear(ANCHOR_ERA, 2024)).toBe('J')
  expect(startShareForYear(ANCHOR_ERA, 2025)).toBe('G')
  expect(startShareForYear(ANCHOR_ERA, 2026)).toBe('D')
  expect(startShareForYear(ANCHOR_ERA, 2027)).toBe('A')
  // Wraps around the 10-share ring: 2024 + 10 years = J again.
  expect(startShareForYear(ANCHOR_ERA, 2034)).toBe('J')
})

test('seasonForYear resolves week + rotated share across an era boundary', () => {
  const eras = [ANCHOR_ERA, { fromYear: 2028, startWeek: 22, startShare: 'D' as const }]
  expect(seasonForYear(eras, 2027)).toEqual({ startWeek: 21, startShare: 'A' })
  expect(seasonForYear(eras, 2028)).toEqual({ startWeek: 22, startShare: 'D' })
  expect(seasonForYear(eras, 2029)).toEqual({ startWeek: 22, startShare: 'A' })
  expect(seasonForYear(eras, 2023)).toBeNull()
})

test('buildSchedules spans min(fromYear) .. currentYear + 1, chronological', () => {
  const schedules = buildSchedules([ANCHOR_ERA], 2026)
  expect(schedules.map((s) => s.year)).toEqual([2024, 2025, 2026, 2027])
  for (const s of schedules) {
    expect(s.blocks[0]?.firstWeek).toBe(21)
    expect(s.blocks[9]?.lastWeek).toBe(40)
    // Band spans must tile the whole season — the desktop week header renders
    // one <td> per band-week, so this pins its 20 columns.
    expect(s.monthBands.reduce((sum, b) => sum + b.span, 0)).toBe(WEEKS_PER_SEASON)
  }
  // 2026 starts at D (J rotated -3 twice) — its first block belongs to D.
  const y2026 = schedules.find((s) => s.year === 2026)
  expect(y2026?.blocks[0]).toEqual({ firstWeek: 21, lastWeek: 22, shareCode: 'D' })
  // Month bands come from each year's real calendar.
  expect(y2026?.monthBands[0]).toEqual({ month: 4, firstWeek: 21, lastWeek: 22, span: 2 })
})

test('buildSchedules returns [] when no eras exist', () => {
  expect(buildSchedules([], 2026)).toEqual([])
})

test('buildSchedules ignores eras that only govern years beyond the range', () => {
  // currentYear 2025 → range 2024..2026; the 2028 era exists but governs nothing yet.
  const schedules = buildSchedules(
    [ANCHOR_ERA, { fromYear: 2028, startWeek: 22, startShare: 'D' as const }],
    2025,
  )
  expect(schedules.map((s) => s.year)).toEqual([2024, 2025, 2026])
  expect(schedules.every((s) => s.blocks[0]?.firstWeek === 21)).toBe(true)
})

test('a block can straddle a month boundary (2027: A = w21 Maj + w22 Jun)', () => {
  const y2027 = buildSchedules([ANCHOR_ERA], 2026).find((s) => s.year === 2027)
  expect(y2027?.blocks[0]).toEqual({ firstWeek: 21, lastWeek: 22, shareCode: 'A' })
  // The two weeks of that block fall in different calendar months.
  expect(monthForISOWeek(2027, 21)).toBe(4) // Maj
  expect(monthForISOWeek(2027, 22)).toBe(5) // Jun
})

test('monthBandsForRange bands an arbitrary range and the season variant delegates', () => {
  const range = monthBandsForRange({ year: 2026, firstWeek: 19, lastWeek: 42 })
  expect(range.reduce((sum, b) => sum + b.span, 0)).toBe(24)
  expect(range[0]?.firstWeek).toBe(19)
  expect(range[range.length - 1]?.lastWeek).toBe(42)
  // The season slice is exactly the range variant over the season weeks.
  expect(monthBandsForSeason({ year: 2026, startWeek: 21 })).toEqual(
    monthBandsForRange({ year: 2026, firstWeek: 21, lastWeek: 40 }),
  )
})
