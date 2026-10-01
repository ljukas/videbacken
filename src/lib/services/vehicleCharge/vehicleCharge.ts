import { count, max, min } from 'drizzle-orm'
import { db } from '~/lib/db'
import { vehicleChargeRecord } from '~/lib/db/schema'
import type { VehicleRecordInput, VehicleRecordSource } from '~/lib/evCharging/vehicle'

/**
 * Stores the car's own charging log (ADR-0021). Idempotent on
 * `(source, source_session_id)`: an already-imported id is left as it was
 * (the export never revises a past charge), so re-importing reports it
 * `unchanged`. One statement, so an import lands whole or not at all.
 * `MAX_IMPORT_ROWS` rows × 9 params stays under Postgres's 65 535 bind-parameter
 * cap; the caller (the procedure's zod input) enforces it, so no chunking here.
 */
export async function importRecords(
  rows: readonly VehicleRecordInput[],
  opts: { source?: VehicleRecordSource } = {},
): Promise<{ inserted: number; unchanged: number }> {
  if (rows.length === 0) return { inserted: 0, unchanged: 0 }
  const source = opts.source ?? 'skoda_export'
  const inserted = await db
    .insert(vehicleChargeRecord)
    .values(rows.map((r) => ({ source, ...r })))
    .onConflictDoNothing({
      target: [vehicleChargeRecord.source, vehicleChargeRecord.sourceSessionId],
    })
    .returning({ id: vehicleChargeRecord.id })
  return { inserted: inserted.length, unchanged: rows.length - inserted.length }
}

/** The span the car's log covers (every record, wherever it charged), or null before any import. */
export async function coverage(): Promise<{ from: Date; to: Date; count: number } | null> {
  const [row] = await db
    .select({
      from: min(vehicleChargeRecord.startAt),
      to: max(vehicleChargeRecord.endAt),
      count: count(),
    })
    .from(vehicleChargeRecord)
  if (!row?.from || !row.to) return null
  return { from: new Date(row.from), to: new Date(row.to), count: row.count }
}
