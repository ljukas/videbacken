import type { CatalogueEntry } from '~/lib/effects/eltariff'

const METERING_POINT_ID = /^\d{18}$/

/**
 * The facility's metering-point ID (anläggnings-ID), from the stored or env
 * facility ID (ADR-0026), or null when it is unset or not 18 digits. Fails closed: a malformed ID is never
 * matched against the catalogue.
 */
export function parseFacilityId(raw: string | undefined): string | null {
  const id = raw?.trim()
  return id && METERING_POINT_ID.test(id) ? id : null
}

/**
 * The catalogue entry whose metering-point range contains `facilityId`
 * (inclusive at both ends), if any. Compared as `BigInt`: 18-digit IDs are far
 * beyond `Number.MAX_SAFE_INTEGER`, where neighbouring IDs collapse together.
 */
export function findCoveringEntry(
  facilityId: string,
  entries: readonly CatalogueEntry[],
): CatalogueEntry | undefined {
  const id = BigInt(facilityId)
  return entries.find(
    (e) => BigInt(e.meteringPointIdFrom) <= id && id <= BigInt(e.meteringPointIdTo),
  )
}
