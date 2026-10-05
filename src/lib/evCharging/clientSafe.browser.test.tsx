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

test('the credential vocabulary is importable client-side', async () => {
  const mod = await import('~/lib/integrationCredentials')
  expect(mod.CREDENTIAL_SOURCES).toContain('zaptec')
  expect(mod.credentialFieldKind('skoda', 'vin')).toBe('text')
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

test('the session paging vocabulary is importable client-side', async () => {
  const paging = await import('~/lib/evCharging/paging')
  expect(paging.SESSION_PAGE_SIZES).toContain(paging.DEFAULT_SESSION_PAGE_SIZE)
  expect(typeof paging.pageItems).toBe('function')
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
  expect(economy.SCORE_MIN_GAP_SHARE).toBe(0.05)
})

test('vehicle vocabulary is importable client-side', async () => {
  const mod = await import('~/lib/evCharging/vehicle')
  expect(mod.VEHICLE_SCOPES).toEqual(['ours', 'other', 'all'])
})

test('the MySkoda export parser is importable and runs client-side', async () => {
  const mod = await import('~/lib/evCharging/skodaExport')
  const { SKODA_EXPORT_FIXTURE } = await import('~test/fixtures/skodaExport')
  expect(mod.parseSkodaExport(SKODA_EXPORT_FIXTURE)).toMatchObject({
    ok: true,
    dropped: 1,
    publicCount: 1,
  })
})

test('the energy-mix derivation math is importable client-side', async () => {
  const supply = await import('~/lib/houseEnergy/mix/supply')
  const shape = await import('~/lib/houseEnergy/mix/shape')
  const pool = await import('~/lib/houseEnergy/mix/pool')
  const carMix = await import('~/lib/houseEnergy/mix/carMix')
  const timeline = await import('~/lib/houseEnergy/mix/houseTimeline')
  expect(typeof supply.houseSupply).toBe('function')
  expect(typeof shape.shapeSession).toBe('function')
  expect(pool.emptyPool().storedKwh).toBe(0)
  expect(typeof carMix.deriveSessionMix).toBe('function')
  expect(typeof timeline.runHouseTimeline).toBe('function')
})
