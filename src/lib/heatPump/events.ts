// Client-safe heat pump event vocabulary (ADR-0027 decision 10). Dependency-free on purpose:
// the schema imports it (drizzle-kit loads that without the `~` alias) and so do the browser
// components. Copy (labels) lives in components/heatPump/eventCopy.ts.

export const HEAT_PUMP_EVENT_KINDS = ['service', 'filter', 'setting', 'other'] as const
export type HeatPumpEventKind = (typeof HEAT_PUMP_EVENT_KINDS)[number]

/** The longest note, in characters (Unicode code points, as Postgres' char_length counts). */
export const HEAT_PUMP_EVENT_NOTE_MAX = 500

/** An event as the browser sees it (`heatPump.events.list`); `heatPumpId` null = every unit. */
export type HeatPumpEventDto = {
  id: string
  /** Stockholm calendar day, YYYY-MM-DD. */
  occurredOn: string
  heatPumpId: string | null
  kind: HeatPumpEventKind
  note: string | null
}

export function isHeatPumpEventKind(value: string): value is HeatPumpEventKind {
  return (HEAT_PUMP_EVENT_KINDS as readonly string[]).includes(value)
}

/** A note's length as the database counts it: code points, so "å" and an emoji are one each. */
export function noteLength(note: string): number {
  return [...note].length
}

/** The note as stored: trimmed, and a blank one is no note. */
export function normalizeNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** One marker on the day chart: a day and a unit (null = every unit), with the kinds logged. */
export type DayEventMarker = { day: string; heatPumpId: string | null; kinds: HeatPumpEventKind[] }

/**
 * The day chart's markers, by Stockholm day: one per unit with events that day, "every unit"
 * first, then units in `unitIds` order (the chart's colour order); each kind once, in the
 * events' order. Events for a unit not in `unitIds` are dropped (the chart has no bar for it).
 */
export function dayEventMarkers(
  events: readonly HeatPumpEventDto[],
  unitIds: readonly string[],
): Map<string, DayEventMarker[]> {
  const rank = (id: string | null) => (id === null ? -1 : unitIds.indexOf(id))
  const byDay = new Map<string, DayEventMarker[]>()
  for (const event of events) {
    if (event.heatPumpId !== null && !unitIds.includes(event.heatPumpId)) continue
    const day = byDay.get(event.occurredOn) ?? []
    let marker = day.find((m) => m.heatPumpId === event.heatPumpId)
    if (!marker) {
      marker = { day: event.occurredOn, heatPumpId: event.heatPumpId, kinds: [] }
      day.push(marker)
      day.sort((a, b) => rank(a.heatPumpId) - rank(b.heatPumpId))
    }
    if (!marker.kinds.includes(event.kind)) marker.kinds.push(event.kind)
    byDay.set(event.occurredOn, day)
  }
  return byDay
}
