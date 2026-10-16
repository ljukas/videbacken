import { expect, test } from 'vitest'

// Client code may only `import type` from services (CLAUDE.md gotcha): a value import pulls db → pg → Buffer into
// the browser and crashes at module init. Evaluating these modules in the browser project proves they don't.
test('the /energy/heat-pumps route module evaluates client-side without a db leak', async () => {
  const mod = await import('~/routes/_authenticated/energy/heat-pumps')
  expect(mod.Route).toBeDefined()
})

test('the heat pump view model and period helpers are importable client-side', async () => {
  expect(typeof (await import('./heatPumpView')).heatPumpView).toBe('function')
  expect(typeof (await import('~/lib/heatPump/period')).monthDays).toBe('function')
})

test('the event vocabulary is importable client-side', async () => {
  const mod = await import('~/lib/heatPump/events')
  expect(typeof mod.dayEventMarkers).toBe('function')
})
