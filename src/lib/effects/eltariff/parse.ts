import { z } from 'zod'
import type { Catalogue } from './eltariff'
import { EltariffError } from './errors'

// Swedish metering-point IDs (anläggnings-ID) are 18 digits.
const meteringPointId = z.string().regex(/^\d{18}$/)

// Only what matching needs is required: a registration whose name is missing
// must still count as coverage, not be dropped as malformed.
const entrySchema = z.object({
  meteringPointIdFrom: meteringPointId,
  meteringPointIdTo: meteringPointId,
  companyName: z
    .string()
    .nullish()
    .catch(null)
    .transform((name) => name?.trim() || null),
})

/**
 * Validates the catalogue. A body that isn't an array, or a non-empty one with
 * no usable entry at all, is API drift (`unexpected_response`) — never an empty
 * catalogue that reads as "not covered". A single malformed entry is dropped and
 * counted instead, so one other company's bad row can't block the check; the
 * caller treats "no match, some dropped" as inconclusive.
 */
export function parseCatalogue(body: unknown, status: number): Catalogue {
  if (!Array.isArray(body)) {
    throw new EltariffError('unexpected_response', 'catalogue', status, {
      message: `eltariff catalogue response is not a list (HTTP ${status})`,
    })
  }
  const entries: Catalogue['entries'] = []
  for (const raw of body) {
    const parsed = entrySchema.safeParse(raw)
    // Range order is checked here, not in a zod refine: zod still runs a refine
    // after a field fails, and `BigInt` throws on a non-digit ID.
    if (!parsed.success) continue
    const { meteringPointIdFrom: from, meteringPointIdTo: to } = parsed.data
    if (BigInt(from) <= BigInt(to)) entries.push(parsed.data)
  }
  if (body.length > 0 && entries.length === 0) {
    throw new EltariffError('unexpected_response', 'catalogue', status, {
      message: `eltariff catalogue has no entry in the expected shape (HTTP ${status})`,
    })
  }
  return { entries, invalidEntries: body.length - entries.length }
}
