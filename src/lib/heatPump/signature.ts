import { extent, sum } from 'd3-array'
import { linearRegression } from 'simple-statistics'
import { addDays, stockholmDayBounds } from '~/lib/time/stockholm'
import type { HeatPumpEventDto } from './events'
import { HEAT_PUMP_DAYS_MAX } from './period'

// The energy signature (ADR-0027 decision 9, spec "Energisignatur"): per unit, each
// qualifying heating day is a point (x = the day's mean indoor − outdoor temperature,
// y = its kWh). A line fitted to the days before an event predicts the days after it.
// A relative before/after comparison on the units' own sensors, not an absolute
// efficiency. Pure and client-safe: the browser computes it from heatPump.days.

/** One unit's Stockholm day, as heatPump.days returns it (step 3). */
export type SignatureDay = {
  day: string
  kwh: number
  heatKwh: number
  coolKwh: number
  insideC: number | null
  outsideC: number | null
  hours: number
  expectedHours: number
}
export type SignaturePoint = {
  day: string
  deltaT: number
  kwh: number
  set: 'before' | 'after'
  /** An after-day outside the before set's ΔT range: drawn hollow, not counted. */
  extrapolated: boolean
}
/** kWh = a + b·ΔT (a: intercept, b: slope). */
export type SignatureFit = { a: number; b: number }
export type SignatureResult =
  | { state: 'not_enough_before'; before: number; points: SignaturePoint[] }
  | {
      state: 'not_enough_after'
      after: number
      needed: 14
      points: SignaturePoint[]
      fit: SignatureFit
    }
  | {
      state: 'ok'
      points: SignaturePoint[]
      fit: SignatureFit
      afterFit: SignatureFit | null
      /** (Σ actual − Σ predicted) ÷ Σ predicted: negative = lower consumption after. */
      change: number
      /** ≈ 95 % margin of `change`: 1,96 × s × √n ÷ Σ predicted (parameter uncertainty ignored). */
      margin: number
      beforeDays: number
      afterDays: number
    }
export type QualifyingDay = SignatureDay & { deltaT: number }

/** Days needed on each side of the event. */
export const SIGNATURE_MIN_DAYS = 14
/** The before set's ΔT must span this much for a slope to mean anything. */
export const SIGNATURE_MIN_SPAN_C = 4
/** The before set: the latest this many qualifying days. */
export const SIGNATURE_MAX_BEFORE_DAYS = 90
/** A heating day: indoor − outdoor at least this much. */
export const SIGNATURE_MIN_DELTA_T_C = 3
/** A heating day: cooling at most this share of the day's kWh. */
export const SIGNATURE_MAX_COOL_SHARE = 0.02
/** A heating day: heating at least this share (a switched-off unit reports 0, one on in heat mode 1). */
export const SIGNATURE_MIN_HEAT_SHARE = 0.5
/** The after line needs this much ΔT spread; narrower, its slope says nothing. */
export const SIGNATURE_MIN_AFTER_LINE_SPAN_C = 1
/** Days fetched before an event: room for the latest 90 qualifying days of a heating season. */
export const SIGNATURE_LOOKBACK_DAYS = 400

const HOUR_MS = 3_600_000

/** The Stockholm day's length in hours: 23, 24 or 25. */
const fullDayHours = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return Math.round((endMs - startMs) / HOUR_MS)
}

/**
 * The days that can be points: every hour present, the unit on and heating (≥ 50 % of
 * the day's kWh), (almost) no cooling, both means present, ΔT ≥ 3 °C, not an event day
 * for the unit. Input order is kept.
 */
export function qualifyingDays(
  days: readonly SignatureDay[],
  eventDays: ReadonlySet<string>,
): QualifyingDay[] {
  const out: QualifyingDay[] = []
  for (const d of days) {
    if (eventDays.has(d.day)) continue
    if (d.insideC === null || d.outsideC === null) continue
    // Every hour of the Stockholm day, not only the expected ones: step 3 clips
    // expectedHours to the newest stored hour (and the unit's first reading), so
    // today's partial day would otherwise pass as complete.
    if (d.hours < d.expectedHours || d.hours !== fullDayHours(d.day)) continue
    // A day with no kWh has no heat share; a switched-off unit (standby only) reports 0.
    if (!(d.kwh > 0) || d.heatKwh < SIGNATURE_MIN_HEAT_SHARE * d.kwh) continue
    if (d.coolKwh > SIGNATURE_MAX_COOL_SHARE * d.kwh) continue
    const deltaT = d.insideC - d.outsideC
    if (deltaT < SIGNATURE_MIN_DELTA_T_C) continue
    out.push({ ...d, deltaT })
  }
  return out
}

/** The events that apply to a unit (its own and Båda), oldest first; same day: input order. */
export function eventsForUnit(
  events: readonly HeatPumpEventDto[],
  heatPumpId: string,
): HeatPumpEventDto[] {
  return events
    .filter((e) => e.heatPumpId === null || e.heatPumpId === heatPumpId)
    .sort((p, q) => p.occurredOn.localeCompare(q.occurredOn))
}

/** The event the card opens on: the unit's latest service, else its latest event, else null. */
export function defaultEventId(
  events: readonly HeatPumpEventDto[],
  heatPumpId: string,
): string | null {
  const own = eventsForUnit(events, heatPumpId)
  return own.filter((e) => e.kind === 'service').at(-1)?.id ?? own.at(-1)?.id ?? null
}

/**
 * The event shown: the chosen one while it applies to the unit, else the unit's default.
 * A choice made on the other unit (an event only it has) never reaches energySignature.
 */
export function selectedEventId(
  events: readonly HeatPumpEventDto[],
  heatPumpId: string,
  chosenId: string | null,
): string | null {
  const applies =
    chosenId !== null && eventsForUnit(events, heatPumpId).some((e) => e.id === chosenId)
  return applies ? chosenId : defaultEventId(events, heatPumpId)
}

/**
 * The days an event's signature needs: from 400 days before it (not before the unit's
 * first reading) to the unit's next event, or today. Callers pass an event that applies
 * to the unit (selectedEventId); an unknown one throws.
 */
export function signatureRange({
  events,
  heatPumpId,
  eventId,
  firstReadingDay,
  today,
}: {
  events: readonly HeatPumpEventDto[]
  heatPumpId: string
  eventId: string
  firstReadingDay: string | null
  today: string
}): { from: string; to: string } {
  const own = eventsForUnit(events, heatPumpId)
  const event = own.find((e) => e.id === eventId)
  if (!event) throw new RangeError(`Event ${eventId} does not apply to heat pump ${heatPumpId}`)
  const back = addDays(event.occurredOn, -SIGNATURE_LOOKBACK_DAYS)
  const from = firstReadingDay !== null && firstReadingDay > back ? firstReadingDay : back
  const next = own.find((e) => e.occurredOn > event.occurredOn)?.occurredOn ?? null
  const to = next !== null && next < today ? next : today
  return { from, to }
}

/** `from … to` (inclusive) as consecutive ranges of at most `maxDays` days: heatPump.days' cap. */
export function signatureChunks(
  from: string,
  to: string,
  maxDays = HEAT_PUMP_DAYS_MAX,
): { from: string; to: string }[] {
  const chunks: { from: string; to: string }[] = []
  for (let start = from; start <= to; start = addDays(start, maxDays)) {
    const end = addDays(start, maxDays - 1)
    chunks.push({ from: start, to: end < to ? end : to })
  }
  return chunks
}

type Xy = { deltaT: number; kwh: number }

/** OLS kWh = a + b·ΔT. simple-statistics returns { m: slope, b: intercept }: mapped, never passed through. */
function fitOf(days: readonly Xy[]): SignatureFit {
  const { m, b } = linearRegression(days.map((d) => [d.deltaT, d.kwh]))
  return { a: b, b: m }
}

const predict = (fit: SignatureFit, deltaT: number) => fit.a + fit.b * deltaT

/** [min, max] ΔT of a non-empty set; null for an empty one. */
function rangeOf(days: readonly Xy[]): [number, number] | null {
  const [lo, hi] = extent(days, (d) => d.deltaT)
  return lo === undefined || hi === undefined ? null : [lo, hi]
}

/**
 * The before fit's residual standard deviation, √(Σ residual² ÷ (n − 2)): the line
 * spent two degrees of freedom (the OLS standard error of the regression).
 */
function residualSd(days: readonly Xy[], fit: SignatureFit): number {
  return Math.sqrt(sum(days, (d) => (d.kwh - predict(fit, d.deltaT)) ** 2) / (days.length - 2))
}

/**
 * The signature around one event for one unit (spec "Energisignatur"). Before set:
 * qualifying days after the unit's previous event (or from the first reading) and
 * before this one, the latest 90. After set: qualifying days after this event and
 * before the unit's next one. Previous / next are strictly earlier / later days, so
 * a second event on the same day cuts neither window (its day is an event day anyway).
 */
export function energySignature({
  days,
  events,
  heatPumpId,
  eventId,
}: {
  days: readonly SignatureDay[]
  events: readonly HeatPumpEventDto[]
  heatPumpId: string
  eventId: string
}): SignatureResult {
  const own = eventsForUnit(events, heatPumpId)
  const event = own.find((e) => e.id === eventId)
  if (!event) throw new RangeError(`Event ${eventId} does not apply to heat pump ${heatPumpId}`)
  const on = event.occurredOn
  const previous = own.filter((e) => e.occurredOn < on).at(-1)?.occurredOn ?? null
  const next = own.find((e) => e.occurredOn > on)?.occurredOn ?? null

  const qualifying = qualifyingDays(days, new Set(own.map((e) => e.occurredOn))).sort((p, q) =>
    p.day.localeCompare(q.day),
  )
  const before = qualifying
    .filter((d) => d.day < on && (previous === null || d.day > previous))
    .slice(-SIGNATURE_MAX_BEFORE_DAYS)
  const after = qualifying.filter((d) => d.day > on && (next === null || d.day < next))

  const range = rangeOf(before)
  // No extrapolation: an after-day outside the before set's ΔT range isn't predicted.
  const outside = (d: Xy) => range !== null && (d.deltaT < range[0] || d.deltaT > range[1])
  const points: SignaturePoint[] = [
    ...before.map((d) => ({
      day: d.day,
      deltaT: d.deltaT,
      kwh: d.kwh,
      set: 'before' as const,
      extrapolated: false,
    })),
    ...after.map((d) => ({
      day: d.day,
      deltaT: d.deltaT,
      kwh: d.kwh,
      set: 'after' as const,
      extrapolated: outside(d),
    })),
  ]

  if (
    range === null ||
    before.length < SIGNATURE_MIN_DAYS ||
    range[1] - range[0] < SIGNATURE_MIN_SPAN_C
  )
    return { state: 'not_enough_before', before: before.length, points }
  const fit = fitOf(before)
  const counted = after.filter((d) => !outside(d))
  if (counted.length < SIGNATURE_MIN_DAYS)
    return {
      state: 'not_enough_after',
      after: counted.length,
      needed: SIGNATURE_MIN_DAYS,
      points,
      fit,
    }

  const predicted = sum(counted, (d) => predict(fit, d.deltaT))
  // A before line that predicts no consumption over these ΔT doesn't describe heating: no ratio.
  if (!(predicted > 0)) return { state: 'not_enough_before', before: before.length, points }
  const actual = sum(counted, (d) => d.kwh)
  const afterRange = rangeOf(counted)
  return {
    state: 'ok',
    points,
    fit,
    afterFit:
      afterRange !== null && afterRange[1] - afterRange[0] >= SIGNATURE_MIN_AFTER_LINE_SPAN_C
        ? fitOf(counted)
        : null,
    change: (actual - predicted) / predicted,
    margin: (1.96 * residualSd(before, fit) * Math.sqrt(counted.length)) / predicted,
    beforeDays: before.length,
    afterDays: counted.length,
  }
}
