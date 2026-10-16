import { desc, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { isForeignKeyViolation } from '~/lib/db/pgError'
import { heatPumpEvent } from '~/lib/db/schema'
import {
  HEAT_PUMP_EVENT_NOTE_MAX,
  type HeatPumpEventDto,
  type HeatPumpEventKind,
  normalizeNote,
  noteLength,
} from '~/lib/heatPump/events'
import { isStockholmDay, stockholmDayOf } from '~/lib/time/stockholm'
import { HeatPumpDomainError } from './errors'

/** An event's editable fields; `heatPumpId` null = every unit. */
export type HeatPumpEventInput = {
  occurredOn: string
  heatPumpId: string | null
  kind: HeatPumpEventKind
  note: string | null
}

// The generated name of the heat_pump_id FK (drizzle: <table>_<column>_<ref table>_<ref column>_fk).
const HEAT_PUMP_FK = 'heat_pump_event_heat_pump_id_heat_pump_id_fk'

const DTO = {
  id: heatPumpEvent.id,
  occurredOn: heatPumpEvent.occurredOn,
  heatPumpId: heatPumpEvent.heatPumpId,
  kind: heatPumpEvent.kind,
  note: heatPumpEvent.note,
}

// The rules, checked before any write. The procedure's Zod already rejects a day that isn't
// a calendar day; reaching here with one is a caller's bug, not a user's mistake.
function columns(input: HeatPumpEventInput, now: Date) {
  if (!isStockholmDay(input.occurredOn)) {
    throw new Error(`occurredOn is not a calendar day: ${input.occurredOn}`)
  }
  if (input.occurredOn > stockholmDayOf(now.getTime())) throw new HeatPumpDomainError('FUTURE_DATE')
  const note = normalizeNote(input.note)
  if (note !== null && noteLength(note) > HEAT_PUMP_EVENT_NOTE_MAX) {
    throw new HeatPumpDomainError('NOTE_TOO_LONG')
  }
  return { occurredOn: input.occurredOn, heatPumpId: input.heatPumpId, kind: input.kind, note }
}

// A unit id that doesn't exist fails the FK: one query, no check-first race.
async function mapUnknownHeatPump<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (isForeignKeyViolation(error, HEAT_PUMP_FK))
      throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
    throw error
  }
}

/** Every event, newest first (by day, then the later entry). Tens of rows: no paging. */
export async function listEvents(): Promise<HeatPumpEventDto[]> {
  return db
    .select(DTO)
    .from(heatPumpEvent)
    .orderBy(desc(heatPumpEvent.occurredOn), desc(heatPumpEvent.createdAt), desc(heatPumpEvent.id))
}

export async function createEvent(
  input: HeatPumpEventInput,
  userId: string,
  now: Date = new Date(),
): Promise<HeatPumpEventDto> {
  const values = { ...columns(input, now), createdBy: userId }
  return mapUnknownHeatPump(async () => {
    const [row] = await db.insert(heatPumpEvent).values(values).returning(DTO)
    return row
  })
}

export async function updateEvent(
  id: string,
  input: HeatPumpEventInput,
  now: Date = new Date(),
): Promise<HeatPumpEventDto> {
  const values = columns(input, now)
  const row = await mapUnknownHeatPump(async () => {
    const [updated] = await db
      .update(heatPumpEvent)
      .set(values)
      .where(eq(heatPumpEvent.id, id))
      .returning(DTO)
    return updated
  })
  if (!row) throw new HeatPumpDomainError('EVENT_NOT_FOUND')
  return row
}

export async function deleteEvent(id: string): Promise<void> {
  const deleted = await db
    .delete(heatPumpEvent)
    .where(eq(heatPumpEvent.id, id))
    .returning({ id: heatPumpEvent.id })
  if (deleted.length === 0) throw new HeatPumpDomainError('EVENT_NOT_FOUND')
}
