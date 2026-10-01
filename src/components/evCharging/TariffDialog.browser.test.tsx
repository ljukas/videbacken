import { ORPCError } from '@orpc/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { statutoryEnergyTaxOre } from '~/lib/evCharging/tariff'
import { tariffErrorMessage } from '~/lib/orpc/tariffErrorMessage'
import { stockholmDayOf } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type Tariff, TariffDialog } from './TariffDialog'

// Mock the oRPC client so a save records its payload (or fails on demand)
// instead of hitting the network; spreading `opts` keeps the dialog's own
// onError/onSettled (same idiom as EditDeviceDialog's test).
const { createFn, updateFn, toastMock } = vi.hoisted(() => ({
  createFn: vi.fn(),
  updateFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    tariff: {
      create: {
        mutationOptions: (opts: Record<string, unknown>) => ({ ...opts, mutationFn: createFn }),
      },
      update: {
        mutationOptions: (opts: Record<string, unknown>) => ({ ...opts, mutationFn: updateFn }),
      },
      key: () => ['tariff'],
    },
    evCharging: { key: () => ['evCharging'] },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const AUG: Tariff = {
  id: 't1',
  validFrom: '2026-08-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  createFn.mockReset().mockResolvedValue(AUG)
  updateFn.mockReset().mockResolvedValue(AUG)
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

const field = (screen: Awaited<ReturnType<typeof renderWithProviders>>['screen'], label: string) =>
  screen.getByLabelText(label, { exact: false })

test('editing pre-fills the period with Swedish decimals', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'edit', tariff: AUG }} onOpenChange={() => {}} />,
  )
  await expect
    .element(field(screen, m.charging_tariff_field_valid_from()))
    .toHaveValue('2026-08-01')
  await expect.element(field(screen, m.charging_tariff_field_markup())).toHaveValue('5,331')
  await expect.element(field(screen, m.charging_tariff_field_grid())).toHaveValue('35,6')
  await expect.element(field(screen, m.charging_tariff_field_vat())).toHaveValue('25')
})

test('a new period from the current one keeps its amounts', async () => {
  const from = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new', from: AUG }} onOpenChange={() => {}} />,
  )
  await expect.element(field(from.screen, m.charging_tariff_field_tax())).toHaveValue('36')
})

test('a blank new period starts empty with 25 % VAT', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new' }} onOpenChange={() => {}} />,
  )
  await expect.element(field(screen, m.charging_tariff_field_markup())).toHaveValue('')
  await expect.element(field(screen, m.charging_tariff_field_vat())).toHaveValue('25')
})

test('saves comma decimals as numbers and closes on success', async () => {
  const onOpenChange = vi.fn()
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new' }} onOpenChange={onOpenChange} />,
  )
  await field(screen, m.charging_tariff_field_valid_from()).fill('2026-09-01')
  await field(screen, m.charging_tariff_field_markup()).fill('-1,5')
  await field(screen, m.charging_tariff_field_grid()).fill('35,60')
  await field(screen, m.charging_tariff_field_tax()).fill('36')
  await screen.getByRole('button', { name: m.common_save() }).click()

  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith(
      {
        validFrom: '2026-09-01',
        retailMarkupOre: -1.5,
        gridTransferOre: 35.6,
        energyTaxOre: 36,
        vatPercent: 25,
      },
      expect.anything(),
    ),
  )
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  expect(toastMock.success).toHaveBeenCalledWith(m.charging_tariff_saved())
})

test('editing sends the id with the new values', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'edit', tariff: AUG }} onOpenChange={() => {}} />,
  )
  await field(screen, m.charging_tariff_field_grid()).fill('40')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() =>
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', gridTransferOre: 40, retailMarkupOre: 5.331 }),
      expect.anything(),
    ),
  )
})

test('rejects text and out-of-range amounts without saving', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new', from: AUG }} onOpenChange={() => {}} />,
  )
  await field(screen, m.charging_tariff_field_grid()).fill('tjugo')
  await field(screen, m.charging_tariff_field_vat()).fill('125')
  await screen.getByRole('button', { name: m.common_save() }).click()

  await expect.element(screen.getByText(m.charging_tariff_error_not_a_number())).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_tariff_error_range({ min: '0', max: '100' })))
    .toBeVisible()
  expect(createFn).not.toHaveBeenCalled()
})

test('a taken start date is shown on the date field and keeps the dialog open', async () => {
  createFn.mockRejectedValue(
    new ORPCError('TARIFF_VALID_FROM_TAKEN', { defined: true, status: 409 }),
  )
  const onOpenChange = vi.fn()
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new', from: AUG }} onOpenChange={onOpenChange} />,
  )
  await screen.getByRole('button', { name: m.common_save() }).click()

  await expect
    .element(screen.getByText(tariffErrorMessage('TARIFF_VALID_FROM_TAKEN')))
    .toBeVisible()
  await expect.element(field(screen, m.charging_tariff_field_valid_from())).toHaveFocus()
  expect(toastMock.error).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalled()
})

test('another domain error is a toast', async () => {
  createFn.mockRejectedValue(new ORPCError('TARIFF_INVALID_VALUE', { defined: true, status: 422 }))
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new', from: AUG }} onOpenChange={() => {}} />,
  )
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(tariffErrorMessage('TARIFF_INVALID_VALUE')),
  )
})

test('a new period starts on the 1st of this month with the statutory energy tax', async () => {
  const firstOfMonth = `${stockholmDayOf(Date.now()).slice(0, 8)}01`
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new' }} onOpenChange={() => {}} />,
  )
  await expect
    .element(field(screen, m.charging_tariff_field_valid_from()))
    .toHaveValue(firstOfMonth)
  const tax = statutoryEnergyTaxOre(firstOfMonth)
  if (tax !== undefined) {
    await expect
      .element(field(screen, m.charging_tariff_field_tax()))
      .toHaveValue(String(tax).replace('.', ','))
  }
})

test('changing the date re-fills the untouched energy tax for that year', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new', from: AUG }} onOpenChange={() => {}} />,
  )
  await field(screen, m.charging_tariff_field_valid_from()).fill('2025-03-01')
  await expect.element(field(screen, m.charging_tariff_field_tax())).toHaveValue('43,9')
})

test('a typed energy tax is not overwritten by a date change', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new', from: AUG }} onOpenChange={() => {}} />,
  )
  await field(screen, m.charging_tariff_field_tax()).fill('26,4')
  await field(screen, m.charging_tariff_field_valid_from()).fill('2025-03-01')
  await expect.element(field(screen, m.charging_tariff_field_tax())).toHaveValue('26,4')
})

test('an amount that looks like kronor is rejected', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new', from: AUG }} onOpenChange={() => {}} />,
  )
  await field(screen, m.charging_tariff_field_grid()).fill('0,356')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await expect.element(screen.getByText(m.charging_tariff_error_looks_like_kronor())).toBeVisible()
  expect(createFn).not.toHaveBeenCalled()
})

test('the unit and hint are announced with the input', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new' }} onOpenChange={() => {}} />,
  )
  const input = field(screen, m.charging_tariff_field_grid()).element()
  const described = (input.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent)
  expect(described).toEqual([m.charging_tariff_unit_ore(), m.charging_tariff_field_grid_hint()])
})

test('a 0 grid fee is a real amount, not a kronor mistake', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new', from: AUG }} onOpenChange={() => {}} />,
  )
  await field(screen, m.charging_tariff_field_grid()).fill('0')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({ gridTransferOre: 0 }),
      expect.anything(),
    ),
  )
})

test('the taken-date error survives a blur and clears once the date changes', async () => {
  // A new period defaults to the 1st of the current month. Pin Date (only) so
  // that default is 2026-09-01 whatever month CI runs in; otherwise filling
  // 2026-10-01 is "no change" during October 2026 and the error never clears.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
  createFn.mockRejectedValue(
    new ORPCError('TARIFF_VALID_FROM_TAKEN', { defined: true, status: 409 }),
  )
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'new', from: AUG }} onOpenChange={() => {}} />,
  )
  const message = tariffErrorMessage('TARIFF_VALID_FROM_TAKEN')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await expect.element(screen.getByText(message)).toBeVisible()

  // Tabbing away (a blur) keeps it…
  await field(screen, m.charging_tariff_field_markup()).click()
  await expect.element(screen.getByText(message)).toBeVisible()

  // …a different date clears it.
  await field(screen, m.charging_tariff_field_valid_from()).fill('2026-10-01')
  await expect.element(screen.getByText(message)).not.toBeInTheDocument()
})

test('editing shows the plain energy-tax hint, not "pre-filled"', async () => {
  const { screen } = await renderWithProviders(
    <TariffDialog open mode={{ kind: 'edit', tariff: AUG }} onOpenChange={() => {}} />,
  )
  await expect.element(screen.getByText(m.charging_tariff_field_tax_hint_plain())).toBeVisible()
  expect(screen.getByText(m.charging_tariff_field_tax_hint()).elements()).toHaveLength(0)
})
