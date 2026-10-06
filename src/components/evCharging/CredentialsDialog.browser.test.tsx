import { ORPCError } from '@orpc/client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { credentialFieldLabel } from '~/lib/integrationCredentialsMessage'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { type CredentialStatus, CredentialsDialog } from './CredentialsDialog'

// Mock the oRPC client so a save or remove records its input (or fails on
// demand) instead of hitting the network; spreading `opts` keeps the dialog's
// own onSettled (same idiom as TariffDialog's test). The mutation keys mirror
// oRPC's, which `credentials.key()` partially matches (the dialog's busy check).
const { setFn, clearFn, toastMock } = vi.hoisted(() => ({
  setFn: vi.fn(),
  clearFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    credentials: {
      set: {
        mutationOptions: (o: Record<string, unknown>) => ({
          ...o,
          mutationKey: ['credentials', 'set'],
          mutationFn: setFn,
        }),
      },
      clear: {
        mutationOptions: (o: Record<string, unknown>) => ({
          ...o,
          mutationKey: ['credentials', 'clear'],
          mutationFn: clearFn,
        }),
      },
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
  const missing = { origin: 'missing', envSet: false } as const
  return {
    encryptionKeyConfigured: true,
    sources: {
      zaptec: {
        fields: { username: missing, password: missing },
        updatedAt: null,
        unreadable: false,
      },
      skoda: {
        fields: {
          apiKey: { origin: 'stored', envSet: false },
          vin: { origin: 'env', envSet: true },
          homeCoordinates: missing,
        },
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
  setFn.mockRejectedValue(new Error('boom'))
  const { screen } = await renderWithProviders(dialog())
  await screen.getByLabelText(API_KEY).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_credentials_save_error()),
  )
  expect(onChanged).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
})

test('a save refused for the missing key says so, not the generic error', async () => {
  // Reachable when the status read failed: the dialog opens without knowing the key is missing.
  setFn.mockRejectedValue(new ORPCError('ENCRYPTION_KEY_MISSING', { defined: true }))
  const { screen } = await renderWithProviders(dialog({ status: undefined }))
  await screen.getByLabelText(API_KEY).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_credentials_key_missing()),
  )
  expect(toastMock.error).not.toHaveBeenCalledWith(m.charging_credentials_save_error())
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

test('a failed remove toasts, runs no sync and keeps focus on Remove', async () => {
  let reject: (err: Error) => void = () => {}
  clearFn.mockReturnValue(new Promise((_, r) => (reject = r)))
  const { screen } = await renderWithProviders(dialog())
  const trigger = screen.getByRole('button', { name: m.charging_credentials_remove() })
  await trigger.click()
  await screen
    .getByRole('alertdialog')
    .getByRole('button', { name: m.charging_credentials_remove() })
    .click()
  // While the remove runs, Remove keeps focus (aria-disabled, not disabled).
  await vi.waitFor(() => expect(clearFn).toHaveBeenCalled())
  await expect.element(trigger).toHaveAttribute('aria-disabled', 'true')
  await expect.element(trigger).toHaveFocus()
  reject(new Error('boom'))
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_credentials_remove_error()),
  )
  expect(onChanged).not.toHaveBeenCalled()
  // Focus is back on Remove, not lost to the page.
  await expect
    .element(screen.getByRole('button', { name: m.charging_credentials_remove() }))
    .toHaveFocus()
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

test('secret inputs ask for a new password and every id is namespaced per source', async () => {
  const { screen } = await renderWithProviders(dialog())
  const apiKey = screen.getByLabelText(API_KEY).element()
  expect(apiKey.getAttribute('autocomplete')).toBe('new-password')
  expect(apiKey.id).toBe('credential-skoda-apiKey')
  expect(apiKey.getAttribute('name')).toBe('credential-skoda-apiKey')
  for (const attr of ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type'])
    expect(apiKey.hasAttribute(attr)).toBe(true)
  const vin = screen.getByLabelText(VIN).element()
  expect(vin.getAttribute('autocomplete')).toBe('off')
  expect(vin.id).toBe('credential-skoda-vin')
  expect(vin.hasAttribute('data-1p-ignore')).toBe(true)
})

test('the VIN is described by its origin, and after INVALID_FIELD by the error too', async () => {
  setFn.mockRejectedValue(
    new ORPCError('INVALID_FIELD', { defined: true, data: { fields: ['vin'] } }),
  )
  const { screen } = await renderWithProviders(dialog())
  const vin = screen.getByLabelText(VIN)
  await expect
    .element(vin)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_origin_env()))
  await vin.fill('x')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect
    .element(vin)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_invalid_vin()))
  await expect
    .element(vin)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_origin_env()))
})

test('a blank submit shows an alert and focuses the first input', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(m.charging_credentials_nothing_to_save())
  await expect.element(screen.getByLabelText(API_KEY)).toHaveFocus()
})

test('the dialog cannot be dismissed while a save is pending', async () => {
  setFn.mockReturnValue(new Promise(() => {}))
  const { screen } = await renderWithProviders(dialog())
  await screen.getByLabelText(API_KEY).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(setFn).toHaveBeenCalled())
  await userEvent.keyboard('{Escape}')
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
  await expect.element(screen.getByRole('dialog')).toBeInTheDocument()
})

test('missing key: focus starts on Cancel, and each input is described by the alert', async () => {
  const { screen } = await renderWithProviders(
    dialog({ status: status({ encryptionKeyConfigured: false }) }),
  )
  await expect.element(screen.getByRole('button', { name: m.common_cancel() })).toHaveFocus()
  await expect
    .element(screen.getByLabelText(API_KEY))
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_key_missing()))
})

test('missing key: remove still works', async () => {
  const { screen } = await renderWithProviders(
    dialog({ status: status({ encryptionKeyConfigured: false }) }),
  )
  const trigger = screen.getByRole('button', { name: m.charging_credentials_remove() })
  await expect.element(trigger).toBeEnabled()
  await trigger.click()
  await screen
    .getByRole('alertdialog')
    .getByRole('button', { name: m.charging_credentials_remove() })
    .click()
  await vi.waitFor(() => expect(clearFn).toHaveBeenCalled())
  expect(clearFn.mock.calls[0][0]).toEqual({ source: 'skoda' })
})

test('save invalidates the credentials and charging queries', async () => {
  const queryClient = makeTestQueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const { screen } = await renderWithProviders(dialog(), { queryClient })
  await screen.getByLabelText(API_KEY).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith('skoda'))
  await vi.waitFor(() => {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credentials'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['evCharging'] })
  })
})

test('unreadable: every field says it cannot be read, never when saved or env', async () => {
  // The source fails closed and never falls back to env (ADR-0026): the env and
  // missing fields read unreadable too.
  const { screen } = await renderWithProviders(dialog({ status: status({}, { unreadable: true }) }))
  await expect
    .element(screen.getByText(m.charging_credentials_origin_unreadable(), { exact: true }).first())
    .toBeVisible()
  expect(
    screen.getByText(m.charging_credentials_origin_unreadable(), { exact: true }).elements(),
  ).toHaveLength(3)
  expect(screen.getByText(/Sparad i appen ·/).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_credentials_origin_env()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_credentials_origin_missing()).elements()).toHaveLength(0)
})

test('the form posts, so a native submit never puts values in the URL', async () => {
  const { screen } = await renderWithProviders(dialog())
  const form = screen.getByLabelText(API_KEY).element().closest('form')
  expect(form?.getAttribute('method')).toBe('post')
})

test('the grid remove confirm names the facility ID', async () => {
  const s = status()
  s.sources.gridTariff = {
    fields: { facilityId: { origin: 'stored', envSet: false } },
    updatedAt: SAVED,
    unreadable: false,
  }
  const { screen } = await renderWithProviders(dialog({ source: 'gridTariff', status: s }))
  await screen.getByRole('button', { name: m.charging_credentials_remove() }).click()
  await expect
    .element(screen.getByRole('alertdialog'))
    .toHaveTextContent(m.charging_credentials_remove_confirm_grid())
})

test('the MyŠkoda link says it opens a new tab', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect
    .element(screen.getByRole('link', { name: m.charging_credentials_skoda_link() }))
    .toHaveAccessibleName(`${m.charging_credentials_skoda_link()} ${m.common_opens_in_new_tab()}`)
})

test('editing a rejected field forgets its server error; the others keep theirs', async () => {
  setFn.mockRejectedValue(
    new ORPCError('INVALID_FIELD', { defined: true, data: { fields: ['vin', 'homeCoordinates'] } }),
  )
  const { screen } = await renderWithProviders(dialog())
  await screen.getByLabelText(VIN).fill('x')
  await screen.getByLabelText(HOME).fill('y')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).toBeVisible()
  // Typing the rejected value back no longer brings its error back: it was dropped.
  await screen.getByLabelText(VIN).fill('xy')
  await screen.getByLabelText(VIN).fill('x')
  await expect
    .element(screen.getByText(m.charging_credentials_invalid_vin()))
    .not.toBeInTheDocument()
  await expect.element(screen.getByText(m.charging_credentials_invalid_home())).toBeVisible()
})
