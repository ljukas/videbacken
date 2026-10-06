import { expect, test } from 'vitest'

// Regression guard (see src/lib/sensor/clientSafe.browser.test.tsx): the Energi
// pages and the definitions they use must evaluate in a real browser without
// pulling a server-only module (services → db → pg, or effects).
test('the house-energy figures are importable client-side', async () => {
  const mod = await import('~/lib/houseEnergy/figures')
  expect(typeof mod.energyFigures).toBe('function')
})

test('the /energy route module evaluates client-side without a db leak', async () => {
  const mod = await import('~/routes/_authenticated/energy/index')
  expect(mod.Route).toBeDefined()
})

test('the period vocabulary is importable client-side', async () => {
  const mod = await import('~/lib/houseEnergy/period')
  expect(typeof mod.parsePeriod).toBe('function')
})
