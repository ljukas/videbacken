import { ORPCError } from '@orpc/client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { credentialFieldLabel } from '~/lib/integrationCredentialsMessage'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type CredentialStatus, CredentialsDialog } from './CredentialsDialog'

// Mock the oRPC client so a save or remove records its input (or fails on
// demand) instead of hitting the network; spreading `opts` keeps the dialog's
// own onSettled (same idiom as TariffDialog's test).
const { setFn, clearFn, toastMock } = vi.hoisted(() => ({
  setFn: vi.fn(),
  clearFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    credentials: {
      set: { mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: setFn }) },
      clear: { mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: clearFn }) },
      key: () => ['credentials'],
    },
    evCharging: { key: () => ['evCharging'] },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const API_KEY = credentialFieldLabel('skoda', 'apiKey')
const VIN = credentialFieldLabel('skoda', 'vin')
const HOME = credentialFieldLabel('skoda', 'homeCoordinates')

const SAVED = new Date('2026-10-05T10:00:00Z')
function status(
  over: Partial<CredentialStatus> = {},
  skoda: Partial<CredentialStatus['sources']['skoda']> = {},
): CredentialStatus {
  const missing = { origin: 'missing' } as const
  return {
    encryptionKeyConfigured: true,
    sources: {
      zaptec: {
        fields: { username: missing, password: missing },
        updatedAt: null,
        unreadable: false,
      },
      skoda: {
        fields: { apiKey: { origin: 'stored' }, vin: { origin: 'env' }, homeCoordinates: missing },
        updatedAt: SAVED,
        unreadable: false,
        ...skoda,
      },
      emaldo: {
        fields: { user: missing, password: missing, appId: missing, appSecret: missing },
        updatedAt: null,
        unreadable: false,
      },
      gridTariff: { fields: { facilityId: missing }, updatedAt: null, unreadable: false },
    },
    ...over,
  }
}

const onChanged = vi.fn()
const onOpenChange = vi.fn()
function dialog(props: Partial<Parameters<typeof CredentialsDialog>[0]> = {}) {
  return (
    <CredentialsDialog
      source="skoda"
      open
      onOpenChange={onOpenChange}
      status={status()}
      suspectFields={null}
      onChanged={onChanged}
      {...props}
    />
  )
}

beforeEach(() => {
  setFn.mockReset().mockResolvedValue({ source: 'skoda', fieldsSet: ['apiKey'] })
  clearFn.mockReset().mockResolvedValue({ cleared: true })
  for (const f of [onChanged, onOpenChange, toastMock.success, toastMock.error]) f.mockReset()
})
afterEach(() => vi.restoreAllMocks())

test('each field shows its origin, and every input starts empty', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect.element(screen.getByText(/Sparad i appen ·/)).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_origin_env())).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_origin_missing())).toBeVisible()
  for (const name of [API_KEY, VIN, HOME])
    await expect.element(screen.getByLabelText(name)).toHaveValue('')
  // Secrets are password inputs; the VIN is plain text.
  expect(screen.getByLabelText(API_KEY).element().getAttribute('type')).toBe('password')
  expect(screen.getByLabelText(VIN).element().getAttribute('type')).toBe('text')
  expect(screen.getByLabelText(API_KEY).element().getAttribute('autocomplete')).toBe('off')
})

test('a suspect field gets its red line', async () => {
  const { screen } = await renderWithProviders(dialog({ suspectFields: ['vin'] }))
  await expect.element(screen.getByText(m.charging_credentials_field_suspect())).toBeVisible()
})

test('Škoda links to the MyŠkoda key page', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect
    .element(screen.getByRole('link', { name: m.charging_credentials_skoda_link() }))
    .toHaveAttribute('href', 'https://go.skoda.eu/api-keys')
})

test('a blank submit is refused without calling the server', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_nothing_to_save())).toBeVisible()
  expect(setFn).not.toHaveBeenCalled()
})

test('after a blank refusal, filling a field lets the save through', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_nothing_to_save())).toBeVisible()
  await screen.getByLabelText(VIN).fill('TMBJJ7NE8L0123456')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() =>
    expect(setFn.mock.calls[0]?.[0]).toEqual({
      source: 'skoda',
      fields: { vin: 'TMBJJ7NE8L0123456' },
    }),
  )
})

test('save sends only the filled fields, toasts, closes and runs the sync', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByLabelText(API_KEY).fill('new-key')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith('skoda'))
  expect(setFn.mock.calls[0][0]).toEqual({ source: 'skoda', fields: { apiKey: 'new-key' } })
  expect(toastMock.success).toHaveBeenCalledWith(m.charging_credentials_saved())
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('INVALID_FIELD lands on every listed field; editing one clears only its own', async () => {
  setFn.mockRejectedValue(
    new ORPCError('INVALID_FIELD', { defined: true, data: { fields: ['vin', 'homeCoordinates'] } }),
  )
  const { screen } = await renderWithProviders(dialog())
  await screen.getByLabelText(VIN).fill('x')
  await screen.getByLabelText(HOME).fill('y')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_invalid_home())).toBeVisible()
  // Focus moves to the first rejected field once the submit has ended.
  await expect.element(screen.getByLabelText(VIN)).toHaveFocus()
  expect(onChanged).not.toHaveBeenCalled()
  expect(toastMock.error).not.toHaveBeenCalled()
  await screen.getByLabelText(VIN).fill('xy')
  await expect
    .element(screen.getByText(m.charging_credentials_invalid_vin()))
    .not.toBeInTheDocument()
  await expect.element(screen.getByText(m.charging_credentials_invalid_home())).toBeVisible()
})

test('REENTER_ALL_FIELDS marks the empty fields', async () => {
  setFn.mockRejectedValue(
    new ORPCError('REENTER_ALL_FIELDS', {
      defined: true,
      data: { fields: ['vin', 'homeCoordinates'] },
    }),
  )
  const { screen } = await renderWithProviders(dialog({ status: status({}, { unreadable: true }) }))
  await expect.element(screen.getByText(m.charging_credentials_unreadable())).toBeVisible()
  await screen.getByLabelText(API_KEY).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect
    .element(screen.getByText(m.charging_credentials_reenter_field()).first())
    .toBeVisible()
  expect(screen.getByText(m.charging_credentials_reenter_field()).elements()).toHaveLength(2)
})

test('a failed save toasts, stays open and runs no sync', async () => {
  setFn.mockRejectedValue(new ORPCError('ENCRYPTION_KEY_MISSING', { defined: true }))
  const { screen } = await renderWithProviders(dialog())
  await screen.getByLabelText(API_KEY).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_credentials_save_error()),
  )
  expect(onChanged).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
})

test('missing key: inputs disabled, remove still offered', async () => {
  const { screen } = await renderWithProviders(
    dialog({ status: status({ encryptionKeyConfigured: false }) }),
  )
  await expect.element(screen.getByText(m.charging_credentials_key_missing())).toBeVisible()
  await expect.element(screen.getByLabelText(API_KEY)).toBeDisabled()
  await expect
    .element(screen.getByRole('button', { name: m.common_save(), exact: true }))
    .toBeDisabled()
  await expect
    .element(screen.getByRole('button', { name: m.charging_credentials_remove() }))
    .toBeVisible()
})

test('remove asks first, then clears and runs the sync', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: m.charging_credentials_remove() }).click()
  const confirm = screen.getByRole('alertdialog')
  await expect.element(confirm).toBeVisible()
  expect(clearFn).not.toHaveBeenCalled()
  await confirm.getByRole('button', { name: m.charging_credentials_remove() }).click()
  await vi.waitFor(() => expect(clearFn).toHaveBeenCalled())
  expect(clearFn.mock.calls[0][0]).toEqual({ source: 'skoda' })
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith('skoda'))
  expect(toastMock.success).toHaveBeenCalledWith(m.charging_credentials_removed())
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('a failed remove toasts and runs no sync', async () => {
  clearFn.mockRejectedValue(new Error('boom'))
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: m.charging_credentials_remove() }).click()
  await screen
    .getByRole('alertdialog')
    .getByRole('button', { name: m.charging_credentials_remove() })
    .click()
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_credentials_remove_error()),
  )
  expect(onChanged).not.toHaveBeenCalled()
})

test('nothing stored: no remove button', async () => {
  const { screen } = await renderWithProviders(dialog({ source: 'zaptec' }))
  await expect
    .element(screen.getByLabelText(credentialFieldLabel('zaptec', 'username')))
    .toBeVisible()
  expect(
    screen.getByRole('button', { name: m.charging_credentials_remove() }).elements(),
  ).toHaveLength(0)
})

test('reopening starts clean', async () => {
  setFn.mockRejectedValue(
    new ORPCError('INVALID_FIELD', { defined: true, data: { fields: ['vin'] } }),
  )
  const { screen, queryClient } = await renderWithProviders(dialog())
  // rerender replaces the whole tree, so keep the provider around the dialog.
  const rerender = (ui: ReactNode) =>
    screen.rerender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
  await screen.getByLabelText(VIN).fill('x')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).toBeVisible()
  await rerender(dialog({ open: false, source: undefined }))
  await expect.element(screen.getByLabelText(VIN)).not.toBeInTheDocument()
  await rerender(dialog())
  await expect.element(screen.getByLabelText(VIN)).toHaveValue('')
  await expect
    .element(screen.getByText(m.charging_credentials_invalid_vin()))
    .not.toBeInTheDocument()
})
