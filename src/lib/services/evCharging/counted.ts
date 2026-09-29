import { and, eq, gte, isNull } from 'drizzle-orm'
import { evChargeSession } from '~/lib/db/schema'
import { NOISE_THRESHOLD_KWH } from '~/lib/evCharging/counting'

// The one "counted session" predicate every charging read shares (overview
// totals, session list, cost): noise (sub-threshold), voided and replaced
// sessions never appear in totals, lists or cost.
export function countedSessionFilter() {
  return and(
    eq(evChargeSession.voided, false),
    isNull(evChargeSession.replacedByZaptecSessionId),
    gte(evChargeSession.energyKwh, NOISE_THRESHOLD_KWH),
  )
}
