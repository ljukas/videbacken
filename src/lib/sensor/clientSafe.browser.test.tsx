import { expect, test } from 'vitest'

// Regression guard for the "Buffer is not defined" crash: the /sensors route and
// its client data modules must be importable in a REAL browser WITHOUT pulling
// the server-only service (`~/lib/services/sensor` → `~/lib/db` → postgres,
// which runs `Buffer.allocUnsafe` at module load). If a runtime value import of
// the service creeps back into any of these, evaluating it here throws exactly
// as it did in the browser, failing this test.
test('the range enum is importable client-side', async () => {
  const mod = await import('~/lib/sensor/range')
  expect(mod.SERIES_RANGES).toContain('24h')
})

test('the chart-data reshape is importable client-side', async () => {
  const mod = await import('~/lib/sensor/chartData')
  expect(typeof mod.toDeviceSeries).toBe('function')
})

test('the /sensors route module evaluates client-side without a db leak', async () => {
  const mod = await import('~/routes/_authenticated/sensors')
  expect(mod.Route).toBeDefined()
})
