export const SHARE_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const

export type ShareCode = (typeof SHARE_CODES)[number]

// Calendar truth: each share occupies this many consecutive weeks per season.
// Purely week math since ADR-0018 — shares are indivisible, so there is no
// ownership concept of a "part" anymore.
export const WEEKS_PER_SHARE = 2
export const WEEKS_PER_SEASON = SHARE_CODES.length * WEEKS_PER_SHARE

// The schedule slips 6 weeks per season for every share (e.g. share A:
// weeks 21/22 → 27/28 the following year). Expressed as a start-share
// rotation: -3 share positions × WEEKS_PER_SHARE = 6 weeks. The rotation
// continues from each era's anchor share (see ADR-0019 and
// `services/season/logic.ts`).
export const YEAR_WEEK_SLIP = 6
export const DEFAULT_YEAR_ROTATION = -(YEAR_WEEK_SLIP / WEEKS_PER_SHARE)

export function isShareCode(value: string): value is ShareCode {
  return (SHARE_CODES as readonly string[]).includes(value)
}

export function shareIndexOf(code: ShareCode): number {
  return SHARE_CODES.indexOf(code)
}

export function rotateShare(code: ShareCode, offset: number): ShareCode {
  const n = SHARE_CODES.length
  const idx = (((shareIndexOf(code) + offset) % n) + n) % n
  return SHARE_CODES[idx]
}
