// Client-safe: a session's plug-in → charging → plug-out segments. Zaptec
// reports energy per (clock-hour) interval, so *where inside an hour* charging
// ran is estimated: an interval delivering less than the session's peak rate
// charged for kWh ÷ peak kW, placed at the interval's start (matches the car's
// end-of-charge taper and a scheduled start on the hour). The page says so.
import { max } from 'd3-array'
import { IDLE_INTERVAL_KWH, PEAK_MIN_INTERVAL_MS } from '~/lib/evCharging/counting'
import { HOUR_MS } from './pieces'
import type { PatternInterval, PatternSession, TimelineSegment, TimelineSession } from './types'

const FULL_HOUR_SHARE = 0.95
const ms = (i: PatternInterval) => i.endAt.getTime() - i.startAt.getTime()
const rateKw = (i: PatternInterval) => (i.energyKwh / ms(i)) * HOUR_MS

export function sessionPeakKw(intervals: PatternInterval[]): number | null {
  const valid = intervals.filter((i) => ms(i) > 0)
  const long = valid.filter((i) => ms(i) >= PEAK_MIN_INTERVAL_MS)
  const peak = max(long.length > 0 ? long : valid, rateKw)
  return peak !== undefined && peak > 0 ? peak : null
}

export function toTimelineSession(session: PatternSession): TimelineSession {
  const winStart = session.startAt.getTime()
  const winEnd = session.endAt.getTime()
  const raw: { a: number; b: number; kind: TimelineSegment['kind'] }[] = []
  const push = (a: number, b: number, kind: TimelineSegment['kind']) => {
    const lo = Math.max(a, winStart)
    const hi = Math.min(b, winEnd)
    if (hi > lo) raw.push({ a: lo, b: hi, kind })
  }

  const peak = sessionPeakKw(session.intervals)
  const sorted = [...session.intervals].sort((x, y) => x.startAt.getTime() - y.startAt.getTime())
  let cursor = winStart
  for (const i of sorted) {
    const a = Math.max(i.startAt.getTime(), cursor)
    const b = i.endAt.getTime()
    if (b <= a) continue
    push(cursor, a, 'idle')
    if (peak === null || i.energyKwh < IDLE_INTERVAL_KWH) {
      push(a, b, 'idle')
    } else {
      const charged = Math.min(ms(i), (i.energyKwh / peak) * HOUR_MS)
      if (charged >= FULL_HOUR_SHARE * ms(i)) {
        push(a, b, 'charging')
      } else {
        const chargeStart = i.startAt.getTime()
        push(a, chargeStart + charged, 'charging')
        push(Math.max(a, chargeStart + charged), b, 'idle')
      }
    }
    cursor = Math.max(cursor, b)
  }
  push(cursor, winEnd, 'idle')

  const merged: typeof raw = []
  for (const seg of raw) {
    const last = merged.at(-1)
    if (last && last.kind === seg.kind && last.b === seg.a) last.b = seg.b
    else merged.push({ ...seg })
  }
  const segments = merged.map((g) => ({
    startAt: new Date(g.a),
    endAt: new Date(g.b),
    kind: g.kind,
  }))
  const chargingMs = merged.filter((g) => g.kind === 'charging').reduce((t, g) => t + g.b - g.a, 0)

  return {
    id: session.id,
    startAt: session.startAt,
    endAt: session.endAt,
    energyKwh: session.energyKwh,
    chargingHours: chargingMs / HOUR_MS,
    hourly: session.intervals.length > 0,
    segments,
  }
}
