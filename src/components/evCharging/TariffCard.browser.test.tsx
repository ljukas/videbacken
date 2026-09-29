import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { TariffCard } from './TariffCard'
import type { Tariff } from './TariffDialog'

const period = (id: string, validFrom: string, retailMarkupOre = 5.331): Tariff => ({
  id,
  validFrom,
  retailMarkupOre,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
})

const TARIFFS = [period('a', '2026-01-01', 4), period('b', '2026-08-01')]

test('lists periods newest first with Swedish amounts, read-only for non-admins', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1024 }}>
      <TariffCard tariffs={TARIFFS} />
    </div>,
  )
  await expect
    .element(screen.getByRole('heading', { name: m.charging_tariff_title() }))
    .toBeVisible()
  const rows = screen.getByRole('row').elements()
  expect(rows[1].textContent).toContain('5,331 öre')
  expect(rows[2].textContent).toContain('4 öre')
  await expect.element(screen.getByText('35,6 öre').first()).toBeVisible()
  expect(screen.getByRole('button', { name: m.charging_tariff_new() }).elements()).toHaveLength(0)
  expect(screen.getByRole('button', { name: /Åtgärder/ }).elements()).toHaveLength(0)
})

test('admins get a new-period button and per-row edit/delete', async () => {
  const onNew = vi.fn()
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  const { screen } = await renderWithProviders(
    <div style={{ width: 1024 }}>
      <TariffCard tariffs={TARIFFS} admin={{ onNew, onEdit, onDelete }} />
    </div>,
  )
  await screen.getByRole('button', { name: m.charging_tariff_new() }).click()
  expect(onNew).toHaveBeenCalledOnce()

  const menus = screen.getByRole('button', { name: /Åtgärder för perioden/ })
  await menus.first().click()
  await screen.getByRole('menuitem', { name: m.common_edit() }).click()
  expect(onEdit).toHaveBeenCalledWith('b')

  await menus.first().click()
  await screen.getByRole('menuitem', { name: m.charging_tariff_delete_action() }).click()
  expect(onDelete).toHaveBeenCalledWith('b')
})

test('empty: admins are invited to add fees; others are told an admin must', async () => {
  const onNew = vi.fn()
  const admin = await renderWithProviders(
    <TariffCard tariffs={[]} admin={{ onNew, onEdit: vi.fn(), onDelete: vi.fn() }} />,
  )
  await expect
    .element(admin.screen.getByText(m.charging_tariff_empty_description_admin()))
    .toBeVisible()
  await admin.screen.getByRole('button', { name: m.charging_tariff_new() }).click()
  expect(onNew).toHaveBeenCalledOnce()
})

test('empty for a non-admin says an admin needs to add the fees', async () => {
  const { screen } = await renderWithProviders(<TariffCard tariffs={[]} />)
  await expect.element(screen.getByText(m.charging_tariff_empty_description())).toBeVisible()
  expect(screen.getByRole('button').elements()).toHaveLength(0)
})
