import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// Lets one test force an unexpected throw while the rest run the real check
// (VITEST: the notConfigured eltariff client).
const control = vi.hoisted(() => ({ throwFromCheck: false, runs: 0 }))
vi.mock('./catalogueCheck', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./catalogueCheck')>()
  return {
    ...actual,
    runCatalogueCheck: (deps: Parameters<typeof actual.runCatalogueCheck>[0]) => {
      control.runs++
      return control.throwFromCheck
        ? Promise.reject(new Error('check exploded'))
        : actual.runCatalogueCheck(deps)
    },
  }
})

import { handleCatalogueCheckCron } from './catalogueCheckCron'

const SECRET = 'test-cron-secret'
const request = (auth?: string) =>
  new Request('http://localhost/api/cron/grid-tariff-catalogue', {
    headers: auth ? { authorization: auth } : {},
  })

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
  vi.stubEnv('GRID_FACILITY_ID', '735999144123456789')
  control.throwFromCheck = false
  control.runs = 0
})
afterEach(() => {
  vi.unstubAllEnvs()
})

test('401 without the secret, with a wrong one, or another scheme — before running anything', async () => {
  for (const auth of [undefined, 'Bearer nope', `Basic ${SECRET}`, SECRET]) {
    expect((await handleCatalogueCheckCron(request(auth))).status).toBe(401)
  }
  expect(control.runs).toBe(0)
})

test('401 when the server has no CRON_SECRET, whatever the request sends', async () => {
  vi.stubEnv('CRON_SECRET', '')
  expect((await handleCatalogueCheckCron(request('Bearer '))).status).toBe(401)
  expect((await handleCatalogueCheckCron(request(`Bearer ${SECRET}`))).status).toBe(401)
  expect(control.runs).toBe(0)
})

test('a failed check is still a 200 with its summary', async () => {
  const res = await handleCatalogueCheckCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    outcome: 'failed',
    code: 'not_configured',
    entries: 0,
    invalidEntries: 0,
    notified: 0,
  })
})

test('an unset facility ID is a 200 not_configured', async () => {
  vi.stubEnv('GRID_FACILITY_ID', '')
  const res = await handleCatalogueCheckCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ outcome: 'not_configured' })
})

test('the response never carries the facility ID', async () => {
  const res = await handleCatalogueCheckCron(request(`Bearer ${SECRET}`))
  expect(await res.text()).not.toContain('735999144123456789')
})

test('an unexpected throw is a 500', async () => {
  control.throwFromCheck = true
  expect((await handleCatalogueCheckCron(request(`Bearer ${SECRET}`))).status).toBe(500)
})
