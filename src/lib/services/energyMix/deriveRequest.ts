import { type DbOrTx, db } from '~/lib/db'
import { energyMixDeriveRequest } from '~/lib/db/schema'
import { isStockholmDay } from '~/lib/time/stockholm'

// A leaf of the energyMix service: the evCharging, spotPrice and houseEnergy
// services queue a derive inside their own write transactions, and energyMix
// itself imports the evCharging service, so this must not.

/**
 * Queues a derive from Stockholm `day` (ADR-0023), in the caller's
 * transaction when given one: the stores queue it with the change they commit,
 * and each sync again before it derives, so the request outlives a derive (or
 * a run) that fails. A malformed day, or one outside 1970–2999, is a
 * RangeError: the derive's day math refuses it, and a queued one would fail
 * every derive.
 */
export async function requestDerive(day: string, dbOrTx: DbOrTx = db): Promise<void> {
  if (!isStockholmDay(day)) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`)
  await dbOrTx.insert(energyMixDeriveRequest).values({ fromDay: day })
}
