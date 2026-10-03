import { z } from 'zod'

// Dependency-free, client-safe vocabulary for "who charged" (ADR-0021). The
// schema's CHECK constraints, the procedures' zod inputs and the UI all read
// these arrays, so the allowed values are single-sourced.
export const VEHICLES = ['ours', 'other'] as const
export type Vehicle = (typeof VEHICLES)[number]
/** What a charging view shows: our car, guests, or every counted session. */
export const VEHICLE_SCOPES = ['ours', 'other', 'all'] as const
export type VehicleScope = (typeof VEHICLE_SCOPES)[number]
/**
 * Why a session has its vehicle: nobody decided (counts as ours), the car's exported log, the car's live state
 * (ADR-0022), or an admin.
 */
export const VEHICLE_SOURCES = ['default', 'skoda', 'skoda_live', 'admin'] as const
export type VehicleSource = (typeof VEHICLE_SOURCES)[number]
export const VEHICLE_RECORD_SOURCES = ['skoda_export'] as const
export type VehicleRecordSource = (typeof VEHICLE_RECORD_SOURCES)[number]

export const vehicleScope = z.enum(VEHICLE_SCOPES)

/** Upper bound on one import (a year of the car's log is ≈ 200 rows). */
export const MAX_IMPORT_ROWS = 5_000

/** Bounds on a log timestamp: wide enough for any real export, narrow enough that Postgres can store it. */
const LOG_MIN = new Date('2000-01-01T00:00:00Z')
const LOG_MAX = new Date('2100-01-01T00:00:00Z')
const logTime = z.date().min(LOG_MIN).max(LOG_MAX)

const socPercent = z.number().int().min(0).max(100).nullable()

/** One row of the car's own charging log, as the browser sends it after parsing the export. */
// Strict: an unexpected column (say a location) is rejected, not silently stripped.
export const vehicleRecordInput = z
  .strictObject({
    sourceSessionId: z.string().trim().min(1).max(100),
    startAt: logTime,
    endAt: logTime,
    energyKwh: z.number().min(0).max(1_000),
    startSocPercent: socPercent,
    endSocPercent: socPercent,
    isPublic: z.boolean(),
  })
  .refine((r) => r.endAt.getTime() >= r.startAt.getTime(), { path: ['endAt'] })
export type VehicleRecordInput = z.infer<typeof vehicleRecordInput>
