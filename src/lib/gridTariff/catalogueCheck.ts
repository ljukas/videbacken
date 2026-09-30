import { eltariff, queue } from '~/lib/effects'
import { type EltariffClient, EltariffError, newCallStats } from '~/lib/effects/eltariff'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import type { Logger } from '~/lib/logger'
import * as userService from '~/lib/services/user'
import { baseLocale } from '~/paraglide/runtime'
import { findCoveringEntry, parseFacilityId } from './coverage'

/**
 * `covered` — our facility is in a catalogue range (admins are emailed).
 * `not_covered` — every entry read cleanly and none covers us.
 * `inconclusive` — no match, but some entries were dropped as malformed, so a
 *   match may have been missed; warned, never read as "not covered".
 * `not_configured` — `GRID_FACILITY_ID` unset or malformed; nothing fetched.
 * `failed` — the catalogue couldn't be read (`code` says why).
 */
export type CatalogueCheckOutcome =
  | 'covered'
  | 'not_covered'
  | 'inconclusive'
  | 'not_configured'
  | 'failed'

export type CatalogueCheckResult = {
  outcome: CatalogueCheckOutcome
  code: IntegrationErrorCode | null
  entries: number
  invalidEntries: number
  /** Admin notices queued (covered only). */
  notified: number
}

type Env = Record<string, string | undefined>

/**
 * The monthly grid-tariff watcher: is our facility covered by a grid company
 * publishing machine-readable tariffs (Eltariff-API)? If so, email every active
 * admin — on every run, until the watcher is replaced by the real grid-fee
 * integration (scope map, Phase 2b). Deliberately outside ADR-0019's health
 * machinery (no lease, snapshot or run history): it imports no data, and a
 * missed month only delays a heads-up. It still fails closed — a missing ID or
 * an unreadable catalogue never sends a "covered" email.
 *
 * The facility ID stays in this process: only the whole catalogue is fetched,
 * and the ID is never logged, returned or put in a message.
 */
export async function runCatalogueCheck(deps: {
  log: Logger
  client?: EltariffClient
  env?: Env
}): Promise<CatalogueCheckResult> {
  const { log, client = eltariff, env = process.env } = deps
  const started = performance.now()
  const stats = newCallStats()
  const result: CatalogueCheckResult = {
    outcome: 'not_configured',
    code: null,
    entries: 0,
    invalidEntries: 0,
    notified: 0,
  }
  let company: string | null = null
  let publishFailures = 0
  let thrown: unknown

  try {
    const facilityId = parseFacilityId(env.GRID_FACILITY_ID)
    if (facilityId === null) {
      result.code = 'not_configured'
      return result
    }

    const catalogue = await client.catalogue({ stats })
    result.entries = catalogue.entries.length
    result.invalidEntries = catalogue.invalidEntries
    const match = findCoveringEntry(facilityId, catalogue.entries)
    if (!match) {
      result.outcome = catalogue.invalidEntries > 0 ? 'inconclusive' : 'not_covered'
      return result
    }

    result.outcome = 'covered'
    company = match.companyName
    const admins = await userService.listActiveAdmins()
    const published = await Promise.allSettled(
      admins.map((admin) =>
        queue.publish('email_grid_tariff_available', {
          to: admin.email,
          companyName: match.companyName,
          locale: baseLocale,
        }),
      ),
    )
    for (const p of published) {
      if (p.status === 'fulfilled') {
        result.notified++
      } else {
        publishFailures++
        log.warn('grid tariff notice publish failed', { error: p.reason })
      }
    }
    return result
  } catch (error) {
    if (error instanceof EltariffError) {
      result.outcome = 'failed'
      result.code = error.code
      return result
    }
    thrown = error
    throw error
  } finally {
    const fields = {
      outcome: thrown === undefined ? result.outcome : 'error',
      code: result.code,
      entries: result.entries,
      invalidEntries: result.invalidEntries,
      company,
      notified: result.notified,
      publishFailures,
      durationMs: Math.round(performance.now() - started),
      requests: stats.requests,
      retries: stats.retries,
      fetchMs: Math.round(stats.fetchMs),
    }
    // Info only for a clean answer; a covered run whose notice didn't reach
    // every admin (or had no admin to reach) is a warning, like every other
    // outcome someone should see.
    const clean =
      result.outcome === 'not_covered' ||
      (result.outcome === 'covered' && result.notified > 0 && publishFailures === 0)
    if (thrown !== undefined) log.error('grid tariff catalogue check', { ...fields, error: thrown })
    else if (clean) log.info('grid tariff catalogue check', fields)
    else log.warn('grid tariff catalogue check', fields)
  }
}
