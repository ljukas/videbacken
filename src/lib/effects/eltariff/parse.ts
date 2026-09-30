import { z } from 'zod'
import type { Catalogue } from './eltariff'
import { EltariffError } from './errors'

// Swedish metering-point IDs (anläggnings-ID) are 18 digits.
const meteringPointId = z.string().regex(/^\d{18}$/)

const entrySchema = z.object({
  companyName: z.string().min(1),
  meteringPointIdFrom: meteringPointId,
  meteringPointIdTo: meteringPointId,
  apiUrl: z.string(),
})

/**
 * Validates the catalogue. A body that isn't an array is API drift
 * (`unexpected_response`). A single malformed entry is dropped and counted
 * instead: one other company's bad row must not hide ours, and dropping an
 * entry can only ever miss coverage, never invent it.
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
    if (parsed.success) entries.push(parsed.data)
  }
  return { entries, invalidEntries: body.length - entries.length }
}
