import { addDays, getMonth, parseISO } from 'date-fns'
import {
  DEFAULT_YEAR_ROTATION,
  rotateShare,
  SHARE_CODES,
  type ShareCode,
  WEEKS_PER_SEASON,
  WEEKS_PER_SHARE,
} from '~/lib/shares/codes'

// A season-convention era (ADR-0019): governs every season year >= fromYear
// until a later era takes over. Rows come from the append-only season_era
// table; everything in this file is pure and takes eras as arguments so it
// tests without a database.
export type SeasonEra = {
  fromYear: number
  startWeek: number
  startShare: ShareCode
}

// A whole-share block: the WEEKS_PER_SHARE consecutive weeks one share
// occupies (ADR-0018 — shares are indivisible, so this is the atomic
// calendar unit the UI renders).
export type ShareBlock = {
  firstWeek: number
  lastWeek: number
  shareCode: ShareCode
}

export type YearSchedule = {
  year: number
  blocks: Array<ShareBlock>
  monthBands: Array<MonthBand>
}

// The era with the greatest fromYear <= year, or null for years before the
// first era (never rendered — buildSchedules starts at min(fromYear)).
export function eraForYear(eras: ReadonlyArray<SeasonEra>, year: number): SeasonEra | null {
  let match: SeasonEra | null = null
  for (const era of eras) {
    if (era.fromYear <= year && (match === null || era.fromYear > match.fromYear)) {
      match = era
    }
  }
  return match
}

// The schedule slips 6 weeks per season (DEFAULT_YEAR_ROTATION = -3 share
// positions per year), continuing from the era's anchor share.
export function startShareForYear(era: SeasonEra, year: number): ShareCode {
  return rotateShare(era.startShare, DEFAULT_YEAR_ROTATION * (year - era.fromYear))
}

// Resolves the two values a year's schedule needs from its governing era.
export function seasonForYear(
  eras: ReadonlyArray<SeasonEra>,
  year: number,
): { startWeek: number; startShare: ShareCode } | null {
  const era = eraForYear(eras, year)
  if (!era) return null
  return { startWeek: era.startWeek, startShare: startShareForYear(era, year) }
}

// Pure: the season's whole-share blocks — one per share, WEEKS_PER_SHARE
// consecutive weeks each, rotating from startShare.
export function shareBlocksForSeason(input: {
  startWeek: number
  startShare: ShareCode
}): Array<ShareBlock> {
  return SHARE_CODES.map((_, i) => {
    const firstWeek = input.startWeek + i * WEEKS_PER_SHARE
    return {
      firstWeek,
      lastWeek: firstWeek + WEEKS_PER_SHARE - 1,
      shareCode: rotateShare(input.startShare, i),
    }
  })
}

// Pure: 0-indexed calendar month of the given ISO week, per the ISO 8601
// rule (the month containing the Thursday of that week). 4 = Maj, 9 = Okt.
export function monthForISOWeek(isoYear: number, isoWeek: number): number {
  const monday = parseISO(`${isoYear}-W${String(isoWeek).padStart(2, '0')}-1`)
  const thursday = addDays(monday, 3)
  return getMonth(thursday)
}

export type MonthBand = {
  month: number
  firstWeek: number
  lastWeek: number
  span: number
}

// Pure: collapses an arbitrary inclusive ISO-week range into contiguous
// same-month bands (generalizes the season variant — the booking strip
// spans the season plus both shoulder blocks, ADR-0020).
export function monthBandsForRange(input: {
  year: number
  firstWeek: number
  lastWeek: number
}): Array<MonthBand> {
  const bands: Array<MonthBand> = []
  for (let week = input.firstWeek; week <= input.lastWeek; week++) {
    const month = monthForISOWeek(input.year, week)
    const last = bands[bands.length - 1]
    if (last && last.month === month) {
      last.lastWeek = week
      last.span += 1
    } else {
      bands.push({ month, firstWeek: week, lastWeek: week, span: 1 })
    }
  }
  return bands
}

// Pure: collapses the 20 season weeks into contiguous same-month bands.
// Each band carries its calendar month (0-indexed), the inclusive week
// range, and the span (so callers can drive `<td colSpan>` directly).
export function monthBandsForSeason(input: { year: number; startWeek: number }): Array<MonthBand> {
  return monthBandsForRange({
    year: input.year,
    firstWeek: input.startWeek,
    lastWeek: input.startWeek + WEEKS_PER_SEASON - 1,
  })
}

// One YearSchedule per year from min(fromYear) through currentYear + 1 —
// full history plus next season for planning (ADR-0019). Chronological
// (oldest first): this is a pure read-model, so how the list is ordered for
// the reader (the Disponeringslista shows newest first) is a presentation
// decision left to the component.
export function buildSchedules(
  eras: ReadonlyArray<SeasonEra>,
  currentYear: number,
): Array<YearSchedule> {
  if (eras.length === 0) return []
  const firstYear = Math.min(...eras.map((e) => e.fromYear))
  const lastYear = currentYear + 1

  const schedules: Array<YearSchedule> = []
  for (let year = firstYear; year <= lastYear; year++) {
    const season = seasonForYear(eras, year)
    // Unreachable within [firstYear, lastYear] — firstYear is an era's
    // fromYear — but keeps the loop total if the range logic ever changes.
    if (!season) continue

    schedules.push({
      year,
      blocks: shareBlocksForSeason(season),
      monthBands: monthBandsForSeason({ year, startWeek: season.startWeek }),
    })
  }
  return schedules
}
