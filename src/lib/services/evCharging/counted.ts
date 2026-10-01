import { and, eq, gte, isNull, type SQL } from 'drizzle-orm'
import { evChargeSession } from '~/lib/db/schema'
import { NOISE_THRESHOLD_KWH } from '~/lib/evCharging/counting'
import type { VehicleScope } from '~/lib/evCharging/vehicle'

// The one "counted session" predicate every charging read shares (overview
// totals, session list, cost, patterns, economy): noise (sub-threshold), voided
// and replaced sessions never appear in totals, lists or cost. `vehicle`
// narrows it to our car or guests (ADR-0021); omitted or 'all' adds nothing.
export function countedSessionFilter(opts: { vehicle?: VehicleScope } = {}): SQL {
  const vehicle = opts.vehicle && opts.vehicle !== 'all' ? opts.vehicle : undefined
  return and(
    eq(evChargeSession.voided, false),
    isNull(evChargeSession.replacedByZaptecSessionId),
    gte(evChargeSession.energyKwh, NOISE_THRESHOLD_KWH),
    vehicle ? eq(evChargeSession.vehicle, vehicle) : undefined,
  ) as SQL
}
