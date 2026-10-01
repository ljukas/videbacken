import { isValid, parseISO } from 'date-fns'
import Papa from 'papaparse'
import { type VehicleRecordInput, vehicleRecordInput } from './vehicle'

// Client-safe parser for the MySkoda app's charging-history CSV (ADR-0021).
// Runs in the admin's browser (the dialog imports it lazily), so the file and
// its location names never reach a server; only the fields below leave.
const COLUMNS = {
  id: 'Session ID',
  start: 'Started on',
  end: 'Ended on',
  kwh: 'Total energy (kWh)',
  startSoc: 'Start SOC (%)',
  endSoc: 'End SOC (%)',
  location: 'Location name',
} as const

export type SkodaParseResult =
  | {
      ok: true
      rows: VehicleRecordInput[]
      dropped: number
      publicCount: number
      from: Date
      to: Date
    }
  | { ok: false; error: 'not_skoda_export' | 'empty' }

// An explicit zone (Z or +hh:mm) is required: parseISO reads a zone-less value
// as browser-local time, which would shift the session by the UTC offset.
const HAS_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i
const date = (v: string | undefined) => {
  const t = v?.trim()
  const d = t && HAS_ZONE.test(t) && t.includes('T') ? parseISO(t) : new Date(Number.NaN)
  return isValid(d) ? d : null
}
/** A blank cell is NaN (the schema rejects it), never 0. */
const num = (v: string | undefined) => (v?.trim() ? Number(v) : Number.NaN)
/** A blank SoC is a legitimate null; an unreadable one is NaN (row dropped). */
const soc = (v: string | undefined) => (v?.trim() ? Math.round(Number(v)) : null)

export function parseSkodaExport(text: string): SkodaParseResult {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  })
  const fields = parsed.meta.fields ?? []
  if (!Object.values(COLUMNS).every((c) => fields.includes(c)))
    return { ok: false, error: 'not_skoda_export' }

  const rows: VehicleRecordInput[] = []
  let dropped = 0
  for (const raw of parsed.data) {
    const candidate = {
      sourceSessionId: raw[COLUMNS.id] ?? '',
      startAt: date(raw[COLUMNS.start]),
      endAt: date(raw[COLUMNS.end]),
      energyKwh: num(raw[COLUMNS.kwh]),
      startSocPercent: soc(raw[COLUMNS.startSoc]),
      endSocPercent: soc(raw[COLUMNS.endSoc]),
      isPublic: Boolean(raw[COLUMNS.location]?.trim()),
    }
    const row = vehicleRecordInput.safeParse(candidate)
    if (row.success) rows.push(row.data)
    else dropped += 1
  }
  if (rows.length === 0) return { ok: false, error: 'empty' }
  return {
    ok: true,
    rows,
    dropped,
    publicCount: rows.filter((r) => r.isPublic).length,
    from: new Date(Math.min(...rows.map((r) => r.startAt.getTime()))),
    to: new Date(Math.max(...rows.map((r) => r.endAt.getTime()))),
  }
}
