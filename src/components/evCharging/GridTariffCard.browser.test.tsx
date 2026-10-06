import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { GridTariffCard } from './GridTariffCard'

test.each([
  ['stored', m.charging_grid_status_stored()],
  ['env', m.charging_grid_status_env()],
  ['missing', m.charging_grid_status_missing()],
] as const)('origin %s reads as its status', async (origin, text) => {
  const { screen } = await renderWithProviders(
    <GridTariffCard facility={{ origin }} unreadable={false} onOpenCredentials={() => {}} />,
  )
  await expect.element(screen.getByText(text)).toBeVisible()
  await expect.element(screen.getByText(m.charging_grid_cadence())).toBeVisible()
})

test('an unreadable row says so', async () => {
  const { screen } = await renderWithProviders(
    <GridTariffCard facility={{ origin: 'stored' }} unreadable onOpenCredentials={() => {}} />,
  )
  await expect.element(screen.getByText(m.charging_grid_status_unreadable())).toBeVisible()
})

test('an unknown status renders no status line', async () => {
  const { screen } = await renderWithProviders(
    <GridTariffCard facility={undefined} unreadable={false} onOpenCredentials={() => {}} />,
  )
  await expect.element(screen.getByText(m.charging_grid_cadence())).toBeVisible()
  for (const text of [
    m.charging_grid_status_stored(),
    m.charging_grid_status_env(),
    m.charging_grid_status_missing(),
    m.charging_grid_status_unreadable(),
  ]) {
    await expect.element(screen.getByText(text)).not.toBeInTheDocument()
  }
})

test('the key button opens the dialog', async () => {
  const onOpen = vi.fn()
  const { screen } = await renderWithProviders(
    <GridTariffCard
      facility={{ origin: 'missing' }}
      unreadable={false}
      onOpenCredentials={onOpen}
    />,
  )
  await screen.getByRole('button', { name: m.charging_grid_button() }).click()
  expect(onOpen).toHaveBeenCalledOnce()
  await expect.element(screen.getByRole('heading', { name: m.charging_grid_title() })).toBeVisible()
})
