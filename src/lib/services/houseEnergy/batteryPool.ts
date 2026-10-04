import { eq, gte, sql } from 'drizzle-orm'
import { type DbOrTx, db } from '~/lib/db'
import { batteryPoolDay } from '~/lib/db/schema'
import type { PoolState } from '~/lib/houseEnergy/mix/pool'
import { isStockholmDay } from '~/lib/time/stockholm'

/**
 * What a pool state was computed with: the capacity C (kWh per 100 % SoC) and
 * the derive math's version. A derive resumes only from a checkpoint whose
 * params equal its own (ADR-0023).
 */
export type PoolParams = { capacityKwh: number; deriveVersion: number }

/** A day-end pool state and the params it was computed with. */
export type PoolCheckpoint = { state: PoolState } & PoolParams

/** 10 bound parameters per row: far under Postgres's 65 535 per statement. */
const POOL_INSERT_BATCH = 5_000

function assertDay(day: string): void {
  if (!isStockholmDay(day)) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
}

/** The battery pool at the end of Stockholm `day`, or null without a checkpoint (ADR-0023). */
export async function getPoolDay(day: string, dbOrTx: DbOrTx = db): Promise<PoolCheckpoint | null> {
  assertDay(day)
  const [row] = await dbOrTx
    .select({
      storedKwh: batteryPoolDay.storedKwh,
      gridKwh: batteryPoolDay.gridKwh,
      gridSpotSekSum: batteryPoolDay.gridSpotSekSum,
      solarKwh: batteryPoolDay.solarKwh,
      solarSpotSekSum: batteryPoolDay.solarSpotSekSum,
      unpricedKwh: batteryPoolDay.unpricedKwh,
      capacityKwh: batteryPoolDay.capacityKwh,
      deriveVersion: batteryPoolDay.deriveVersion,
    })
    .from(batteryPoolDay)
    .where(eq(batteryPoolDay.day, day))
  if (!row) return null
  const { capacityKwh, deriveVersion, ...state } = row
  return { state, capacityKwh, deriveVersion }
}

/**
 * Replaces every checkpoint from `day` on with `rows` (all on or after `day`),
 * computed with `params`: delete + insert, atomically (its own
 * transaction, or the caller's). A row before `day` or a malformed day is a
 * programming error: RangeError, nothing written.
 */
export async function replacePoolDaysFrom(
  day: string,
  rows: readonly { day: string; state: PoolState }[],
  params: PoolParams,
  dbOrTx: DbOrTx = db,
): Promise<void> {
  assertDay(day)
  for (const row of rows) {
    assertDay(row.day)
    if (row.day < day) throw new RangeError(`Pool day ${row.day} is before ${day}`)
  }
  const values = rows.map((r) => ({
    day: r.day,
    storedKwh: r.state.storedKwh,
    gridKwh: r.state.gridKwh,
    gridSpotSekSum: r.state.gridSpotSekSum,
    solarKwh: r.state.solarKwh,
    solarSpotSekSum: r.state.solarSpotSekSum,
    unpricedKwh: r.state.unpricedKwh,
    capacityKwh: params.capacityKwh,
    deriveVersion: params.deriveVersion,
  }))
  const write = async (tx: DbOrTx) => {
    await tx.delete(batteryPoolDay).where(gte(batteryPoolDay.day, day))
    for (let i = 0; i < values.length; i += POOL_INSERT_BATCH) {
      await tx.insert(batteryPoolDay).values(values.slice(i, i + POOL_INSERT_BATCH))
    }
  }
  if (dbOrTx === db) await db.transaction(write)
  else await write(dbOrTx)
}

export type BatteryCapacity = {
  /** kWh delivered per 100 % SoC. */
  capacityKwh: number
  dischargedKwh: number
  socDropPct: number
  pairs: number
  from: Date
  to: Date
}

/**
 * C, measured from every stored reading (spec "Derivation" 3): Σ discharge ÷
 * Σ SoC drop / 100 over adjacent pairs of buckets (5 min apart, both with a
 * SoC) that only discharge. A row's SoC is its bucket's mid-point, so the SoC
 * change between two rows spans half of each bucket: a pair counts the mean
 * of its two discharges. Null without such pairs or without a net drop.
 * `from`/`to`: the first pair's first bucket and the last pair's second.
 */
export async function measureBatteryCapacity(dbOrTx: DbOrTx = db): Promise<BatteryCapacity | null> {
  const result = await dbOrTx.execute<{
    discharged: number | null
    soc_drop: number | null
    pairs: number
    first: Date | string | null
    last: Date | string | null
  }>(sql`
    WITH x AS (
      SELECT bucket_start,
        battery_charge_solar_kwh + battery_charge_grid_kwh + battery_charge_ac_kwh AS charged,
        battery_discharge_kwh AS discharged,
        battery_soc_pct AS soc,
        lead(bucket_start) OVER w AS next_start,
        lead(battery_charge_solar_kwh + battery_charge_grid_kwh + battery_charge_ac_kwh) OVER w AS next_charged,
        lead(battery_discharge_kwh) OVER w AS next_discharged,
        lead(battery_soc_pct) OVER w AS next_soc
      FROM house_energy_reading
      WINDOW w AS (ORDER BY bucket_start)
    )
    SELECT sum((discharged + next_discharged) / 2)::float8 AS discharged,
           sum(soc - next_soc)::float8 AS soc_drop,
           count(*)::int AS pairs,
           min(bucket_start) AS first,
           max(next_start) AS last
    FROM x
    WHERE next_start = bucket_start + interval '5 minutes'
      AND charged = 0 AND next_charged = 0
      AND discharged > 0 AND next_discharged > 0
      AND soc IS NOT NULL AND next_soc IS NOT NULL
  `)
  const row = result.rows[0]
  if (!row || row.pairs === 0 || row.discharged === null || row.soc_drop === null) return null
  if (!(row.soc_drop > 0) || row.first === null || row.last === null) return null
  return {
    capacityKwh: row.discharged / (row.soc_drop / 100),
    dischargedKwh: row.discharged,
    socDropPct: row.soc_drop,
    pairs: row.pairs,
    from: new Date(row.first),
    to: new Date(row.last),
  }
}
