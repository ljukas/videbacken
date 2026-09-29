import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { TotalsTiles } from './TotalsTiles'

test('renders this month / this year / all time with kWh and session counts', async () => {
  const { screen } = await renderWithProviders(
    <TotalsTiles
      tiles={{
        thisMonth: { kwh: 42.25, sessions: 3 },
        thisYear: { kwh: 812.5, sessions: 51 },
        allTime: { kwh: 2345.04, sessions: 180 },
      }}
    />,
  )
  await expect.element(screen.getByText(m.charging_tile_this_month())).toBeVisible()
  await expect.element(screen.getByText(m.charging_tile_this_year())).toBeVisible()
  await expect.element(screen.getByText(m.charging_tile_all_time())).toBeVisible()

  // sv-SE formatting: decimal comma, (narrow no-break) space as thousands separator.
  await expect.element(screen.getByText('42,3 kWh')).toBeVisible()
  await expect.element(screen.getByText('812,5 kWh')).toBeVisible()
  await expect.element(screen.getByText(/^2\s345,0 kWh$/)).toBeVisible()
  await expect.element(screen.getByText(m.charging_tile_sessions({ count: 51 }))).toBeVisible()
})

test('zero totals render as 0,0 kWh and 0 sessions', async () => {
  const zero = { kwh: 0, sessions: 0 }
  const { screen } = await renderWithProviders(
    <TotalsTiles tiles={{ thisMonth: zero, thisYear: zero, allTime: zero }} />,
  )
  expect(screen.getByText('0,0 kWh').elements()).toHaveLength(3)
  expect(screen.getByText(m.charging_tile_sessions({ count: 0 })).elements()).toHaveLength(3)
})

test('session counts use the singular for one and group thousands', async () => {
  const { screen } = await renderWithProviders(
    <TotalsTiles
      tiles={{
        thisMonth: { kwh: 2, sessions: 1 },
        thisYear: { kwh: 12_345, sessions: 2 },
        allTime: { kwh: 12_345, sessions: 12_345 },
      }}
    />,
  )
  await expect.element(screen.getByText('1 session', { exact: true })).toBeVisible()
  await expect.element(screen.getByText('2 sessioner', { exact: true })).toBeVisible()
  await expect.element(screen.getByText(/^12\s345 sessioner$/)).toBeVisible()
})
