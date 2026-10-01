import { expect, test } from 'vitest'

// Regression guard for the "Buffer is not defined" crash (see
// `src/lib/sensor/clientSafe.browser.test.tsx`): the /charging route and the
// client-safe modules it relies on must evaluate in a REAL browser without
// pulling a server-only module (`~/lib/services/*` → `~/lib/db` → postgres, or
// `~/lib/effects/*`). A runtime value import of one of those creeping in makes
// the import below throw exactly as it would in the browser.
test('the noise threshold is importable client-side', async () => {
  const mod = await import('~/lib/evCharging/counting')
  expect(mod.NOISE_THRESHOLD_KWH).toBe(0.5)
})

test('the integration-health vocabulary is importable client-side', async () => {
  const mod = await import('~/lib/integrationHealth')
  expect(mod.INTEGRATION_SOURCES).toContain('zaptec')
})

test('the integration-health copy is importable client-side', async () => {
  const mod = await import('~/lib/integrationHealthMessage')
  expect(typeof mod.integrationErrorMessage).toBe('function')
})

test('the cost math, price slots, zones and Stockholm time helpers are importable client-side', async () => {
  const cost = await import('~/lib/evCharging/cost')
  const slots = await import('~/lib/spotPrice/slots')
  const zones = await import('~/lib/spotPrice/zones')
  const time = await import('~/lib/time/stockholm')
  expect(typeof cost.priceIntervals).toBe('function')
  expect(typeof slots.validateDaySlots).toBe('function')
  expect(zones.SPOT_ZONE).toBe('SE3')
  expect(time.stockholmDayOf(Date.UTC(2026, 8, 27, 22))).toBe('2026-09-28')
})

test('the tariff limits and tariff error copy are importable client-side', async () => {
  const limits = await import('~/lib/evCharging/tariff')
  const copy = await import('~/lib/orpc/tariffErrorMessage')
  expect(limits.TARIFF_LIMITS.vatPercent.max).toBe(100)
  expect(typeof copy.tariffErrorMessage).toBe('function')
})

test('the /charging route module evaluates client-side without a db leak', async () => {
  const mod = await import('~/routes/_authenticated/charging/index')
  expect(mod.Route).toBeDefined()
})

test('the patterns module and the /charging/patterns route evaluate client-side', async () => {
  const patterns = await import('~/lib/evCharging/patterns')
  expect(typeof patterns.buildPatterns).toBe('function')
  const route = await import('~/routes/_authenticated/charging/patterns')
  expect(route.Route).toBeDefined()
})

test('the charging economy math is importable client-side', async () => {
  const economy = await import('~/lib/evCharging/economy')
  expect(typeof economy.analyzeSession).toBe('function')
  expect(economy.SCORE_MIN_GAP_SEK).toBe(0.5)
})
