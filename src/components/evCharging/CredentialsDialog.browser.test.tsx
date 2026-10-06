import { ORPCError } from '@orpc/client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { CredentialSource } from '~/lib/integrationCredentials'
import { credentialFieldLabel, credentialFieldList } from '~/lib/integrationCredentialsMessage'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { type CredentialStatus, CredentialsDialog } from './CredentialsDialog'
import { formatDate } from './format'
import type { HomePositionMapProps } from './HomePositionMap'

// Mock the oRPC client so a save or remove records its input (or fails on
// demand) instead of hitting the network; spreading `opts` keeps the dialog's
// own onSettled (same idiom as TariffDialog's test). The mutation keys mirror
// oRPC's, which `credentials.key()` partially matches (the dialog's busy check).
const { setFn, clearFn, toastMock, homePositionFn, searchFn, webgl, mapState } = vi.hoisted(() => ({
  setFn: vi.fn(),
  clearFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
  homePositionFn: vi.fn(),
  searchFn: vi.fn(),
  webgl: { ok: true },
  mapState: { throws: false, last: null as null | Record<string, unknown> },
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
      homePosition: {
        queryOptions: (o: Record<string, unknown> = {}) => ({
          ...o,
          queryKey: ['credentials', 'homePosition'],
          queryFn: homePositionFn,
        }),
      },
      searchAddress: {
        queryOptions: (o: { input: { query: string } } & Record<string, unknown>) => ({
          ...o,
          queryKey: ['credentials', 'searchAddress', o.input],
          queryFn: () => searchFn(o.input),
        }),
      },
      key: () => ['credentials'],
    },
    evCharging: { key: () => ['evCharging'] },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('./mapSupport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mapSupport')>()),
  supportsWebGL2: () => webgl.ok,
}))
// The real map needs WebGL and tiles: a stand-in that shows its props and can pick.
vi.mock('./HomePositionMap', () => ({
  HomePositionMap: (props: HomePositionMapProps) => {
    if (mapState.throws) throw new Error('GPU init failed')
    mapState.last = props as unknown as Record<string, unknown>
    return (
      <div data-testid="map" data-point={JSON.stringify(props.point)}>
        <button
          type="button"
          onClick={() => props.onPick({ latitude: 57.123456789, longitude: 11.987654321 })}
        >
          fake map click
        </button>
      </div>
    )
  },
}))

const API_KEY = credentialFieldLabel('skoda', 'apiKey')
const VIN = credentialFieldLabel('skoda', 'vin')
const HOME = credentialFieldLabel('skoda', 'homeCoordinates')

// The field action buttons are named "{action}, {field}" (visible text first, WCAG 2.5.3).
const actionName = (action: string, field: string) =>
  m.charging_credentials_field_action_label({ action, field })
const REPLACE_API_KEY = actionName(m.charging_credentials_replace(), API_KEY)
const SET_VIN = actionName(m.charging_credentials_set_in_app(), VIN)
const closeName = (field: string) => actionName(m.charging_credentials_close_field(), field)
const CHOOSE_HOME = actionName(m.charging_credentials_choose_on_map(), HOME)
type Screen = Awaited<ReturnType<typeof renderWithProviders>>['screen']
/** The home field starts closed even when missing: open it on the map. */
async function openHome(screen: Screen) {
  await screen.getByRole('button', { name: CHOOSE_HOME }).click()
}

const SAVED = new Date('2026-10-05T10:00:00Z')
type SkodaFields = CredentialStatus['sources']['skoda']['fields']
/** Every Škoda field set (none missing): apiKey and vin stored, the home position from env. */
const ALL_SET: SkodaFields = {
  apiKey: { origin: 'stored', envSet: false },
  vin: { origin: 'stored', envSet: false },
  homeCoordinates: { origin: 'env', envSet: true },
}

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
  homePositionFn.mockReset().mockResolvedValue(null)
  searchFn.mockReset().mockResolvedValue([])
  webgl.ok = true
  mapState.throws = false
  for (const f of [onChanged, onOpenChange, toastMock.success, toastMock.error]) f.mockReset()
})
afterEach(() => vi.restoreAllMocks())

test('stored and env fields start closed with badge, summary and a named reveal button', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect
    .element(screen.getByText(m.charging_credentials_badge_stored(), { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText(m.charging_credentials_badge_env(), { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText(m.charging_credentials_badge_missing(), { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText(m.charging_credentials_origin_stored({ date: formatDate(SAVED) })))
    .toBeVisible()
  await expect.element(screen.getByText('SKODA_VIN', { exact: true })).toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: REPLACE_API_KEY }))
    .toMatchTextContent(m.charging_credentials_replace())
  await expect
    .element(screen.getByRole('button', { name: SET_VIN }))
    .toMatchTextContent(m.charging_credentials_set_in_app())
  expect(screen.getByLabelText(API_KEY, { exact: true }).elements()).toHaveLength(0)
  expect(screen.getByLabelText(VIN, { exact: true }).elements()).toHaveLength(0)
  // A missing home position starts closed too: the map loads only on request.
  await expect
    .element(screen.getByText(m.charging_credentials_badge_missing(), { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toBeVisible()
  expect(screen.getByLabelText(HOME, { exact: true }).elements()).toHaveLength(0)
})

test('secrets are password inputs; the VIN is plain text', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await screen.getByRole('button', { name: SET_VIN }).click()
  expect(screen.getByLabelText(API_KEY, { exact: true }).element().getAttribute('type')).toBe(
    'password',
  )
  expect(screen.getByLabelText(VIN, { exact: true }).element().getAttribute('type')).toBe('text')
})

test('the home position reveal button speaks of the map', async () => {
  const { screen } = await renderWithProviders(dialog({ status: status({}, { fields: ALL_SET }) }))
  await expect
    .element(
      screen.getByRole('button', {
        name: actionName(m.charging_credentials_choose_on_map(), HOME),
      }),
    )
    .toMatchTextContent(m.charging_credentials_choose_on_map())
})

test('a stored home position is changed on the map', async () => {
  const fields = { ...ALL_SET, homeCoordinates: { origin: 'stored', envSet: false } } as const
  const { screen } = await renderWithProviders(dialog({ status: status({}, { fields }) }))
  const change = screen.getByRole('button', {
    name: actionName(m.charging_credentials_change_on_map(), HOME),
  })
  await expect.element(change).toMatchTextContent(m.charging_credentials_change_on_map())
  await change.click()
  await expect.element(screen.getByLabelText(m.charging_home_search_label())).toHaveFocus()
  await expect.element(screen.getByTestId('map')).toBeVisible()
  const coords = screen.getByLabelText(HOME, { exact: true })
  expect(coords.element().getAttribute('type')).toBe('text')
})

test('Byt reveals and focuses the input with its hints above it', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  const input = screen.getByLabelText(API_KEY, { exact: true })
  await expect.element(input).toHaveFocus()
  await expect.element(input).toHaveValue('')
  const hint = screen.getByText(m.charging_credentials_keeps_current())
  await expect.element(hint).toBeVisible()
  // The hint precedes the input in the DOM, and describes it.
  expect(
    hint.element().compareDocumentPosition(input.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0)
  await expect
    .element(input)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_keeps_current()))
  // A stored field never says it overrides the environment variable.
  expect(screen.getByText(m.charging_credentials_overrides_env()).elements()).toHaveLength(0)
})

test('an env field, once opened, says a saved value overrides the variable', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: SET_VIN }).click()
  await expect.element(screen.getByText(m.charging_credentials_keeps_current())).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_overrides_env())).toBeVisible()
  // The format hint comes first.
  const hint = screen.getByText(m.charging_credentials_hint_vin()).element()
  const overrides = screen.getByText(m.charging_credentials_overrides_env()).element()
  expect(hint.compareDocumentPosition(overrides) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
})

test('Avbryt clears what was typed, and the field is not sent', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await screen.getByLabelText(API_KEY, { exact: true }).fill('typed-then-abandoned')
  const close = screen.getByRole('button', { name: closeName(API_KEY) })
  await expect.element(close).toMatchTextContent(m.charging_credentials_close_field())
  await close.click()
  await expect.element(screen.getByLabelText(API_KEY, { exact: true })).not.toBeInTheDocument()
  // Focus lands on the reveal button that replaced the input, not on the page.
  await expect.element(screen.getByRole('button', { name: REPLACE_API_KEY })).toHaveFocus()
  // Reopening shows an empty input, not what was typed.
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await expect.element(screen.getByLabelText(API_KEY, { exact: true })).toHaveValue('')
  await screen.getByRole('button', { name: closeName(API_KEY) }).click()
  await openHome(screen)
  await screen.getByLabelText(HOME, { exact: true }).fill('59.33,18.07')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(setFn).toHaveBeenCalled())
  expect(setFn.mock.calls[0][0]).toEqual({
    source: 'skoda',
    fields: { homeCoordinates: '59.33,18.07' },
  })
})

test('a missing field has no Avbryt link', async () => {
  const { screen } = await renderWithProviders(dialog({ source: 'zaptec' }))
  const username = credentialFieldLabel('zaptec', 'username')
  await expect.element(screen.getByLabelText(username, { exact: true })).toBeVisible()
  expect(screen.getByRole('button', { name: closeName(username) }).elements()).toHaveLength(0)
})

test('a missing home position opened on the map can be closed again', async () => {
  const { screen } = await renderWithProviders(dialog())
  await openHome(screen)
  await expect.element(screen.getByLabelText(HOME, { exact: true })).toBeVisible()
  await screen.getByRole('button', { name: closeName(HOME) }).click()
  await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toHaveFocus()
})

test('a closed home field never fetches the saved pin', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toBeVisible()
  await new Promise((r) => setTimeout(r, 50))
  expect(homePositionFn).not.toHaveBeenCalled()
  await openHome(screen)
  await vi.waitFor(() => expect(homePositionFn).toHaveBeenCalledTimes(1))
})

test('a saved pin seeds the input, and Avbryt unseeds it: Spara sends no home position', async () => {
  homePositionFn.mockResolvedValue({ latitude: 59.3293, longitude: 18.0686 })
  const { screen } = await renderWithProviders(
    dialog({
      status: status(
        {},
        { fields: { ...ALL_SET, homeCoordinates: { origin: 'stored', envSet: false } } },
      ),
    }),
  )
  const change = actionName(m.charging_credentials_change_on_map(), HOME)
  await screen.getByRole('button', { name: change }).click()
  await expect
    .element(screen.getByLabelText(HOME, { exact: true }))
    .toHaveValue('59.32930,18.06860')
  await screen.getByRole('button', { name: closeName(HOME) }).click()
  await screen
    .getByRole('button', { name: actionName(m.charging_credentials_replace(), VIN) })
    .click()
  await screen.getByLabelText(VIN, { exact: true }).fill('TMBJJ7NE8L0123456')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(setFn).toHaveBeenCalled())
  expect(setFn.mock.calls[0][0]).toEqual({ source: 'skoda', fields: { vin: 'TMBJJ7NE8L0123456' } })
  // Reopened, the saved pin seeds again.
  await screen.getByRole('button', { name: change }).click()
  await expect
    .element(screen.getByLabelText(HOME, { exact: true }))
    .toHaveValue('59.32930,18.06860')
})

test('a pin picked on the map is what Spara sends', async () => {
  const { screen } = await renderWithProviders(dialog())
  await openHome(screen)
  await screen.getByRole('button', { name: 'fake map click' }).click()
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(setFn).toHaveBeenCalled())
  expect(setFn.mock.calls[0][0]).toEqual({
    source: 'skoda',
    fields: { homeCoordinates: '57.12346,11.98765' },
  })
})

test('an unreadable source opens the picker with the other fields', async () => {
  const { screen } = await renderWithProviders(dialog({ status: status({}, { unreadable: true }) }))
  await expect.element(screen.getByLabelText(m.charging_home_search_label())).toBeVisible()
  await expect.element(screen.getByLabelText(HOME, { exact: true })).toBeVisible()
})

test('with the encryption key missing the home field cannot be opened', async () => {
  const { screen } = await renderWithProviders(
    dialog({ status: status({ encryptionKeyConfigured: false }) }),
  )
  await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toBeDisabled()
  expect(homePositionFn).not.toHaveBeenCalled()
})

test('a server error opens the field it names', async () => {
  setFn.mockRejectedValue(
    new ORPCError('REENTER_ALL_FIELDS', { defined: true, data: { fields: ['apiKey'] } }),
  )
  const { screen } = await renderWithProviders(dialog())
  await openHome(screen)
  await screen.getByLabelText(HOME, { exact: true }).fill('59.33,18.07')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByLabelText(API_KEY, { exact: true })).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_reenter_field())).toBeVisible()
  await expect.element(screen.getByLabelText(API_KEY, { exact: true })).toHaveFocus()
})

test('with nothing open the footer says Stäng and Spara is disabled', async () => {
  const { screen } = await renderWithProviders(dialog({ status: status({}, { fields: ALL_SET }) }))
  const save = screen.getByRole('button', { name: m.common_save(), exact: true })
  await expect
    .element(screen.getByRole('button', { name: m.common_close(), exact: true }))
    .toBeVisible()
  await expect.element(save).toBeDisabled()
  await screen
    .getByRole('button', { name: actionName(m.charging_credentials_replace(), VIN) })
    .click()
  await expect
    .element(screen.getByRole('button', { name: m.common_cancel(), exact: true }))
    .toBeVisible()
  await expect.element(save).toBeEnabled()
  // Closing the last open field brings Stäng back.
  await screen.getByRole('button', { name: closeName(VIN) }).click()
  await expect
    .element(screen.getByRole('button', { name: m.common_close(), exact: true }))
    .toBeVisible()
  await expect.element(save).toBeDisabled()
})

test('unknown status opens every field but the home position, without badges or Avbryt links', async () => {
  const { screen } = await renderWithProviders(dialog({ status: undefined }))
  for (const name of [API_KEY, VIN])
    await expect.element(screen.getByLabelText(name, { exact: true })).toBeVisible()
  for (const badge of [
    m.charging_credentials_badge_stored(),
    m.charging_credentials_badge_env(),
    m.charging_credentials_badge_missing(),
    m.charging_credentials_badge_unreadable(),
  ])
    expect(screen.getByText(badge, { exact: true }).elements()).toHaveLength(0)
  for (const name of [API_KEY, VIN, HOME])
    expect(screen.getByRole('button', { name: closeName(name) }).elements()).toHaveLength(0)
  // The map loads only when asked for: the home field stays closed, and nothing is fetched.
  await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toBeVisible()
  await new Promise((r) => setTimeout(r, 50))
  expect(homePositionFn).not.toHaveBeenCalled()
})

test('the input keeps the field label as its accessible name', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  // A password input has no textbox role; the accessible name is what matters.
  await expect
    .element(screen.getByLabelText(API_KEY, { exact: true }))
    .toHaveAccessibleName(API_KEY)
  // The label text is rendered once (the row header), not twice.
  expect(screen.getByText(API_KEY, { exact: true }).elements()).toHaveLength(1)
})

test('the grid dialog says what the facility ID is for', async () => {
  const { screen } = await renderWithProviders(dialog({ source: 'gridTariff' }))
  await expect
    .element(screen.getByRole('dialog'))
    .toHaveAccessibleDescription(m.charging_credentials_dialog_description_grid())
})

test('the dialog says what the credentials are for', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect
    .element(screen.getByRole('dialog'))
    .toHaveAccessibleDescription(
      m.charging_credentials_dialog_description({ source: integrationSourceName('skoda') }),
    )
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
  await openHome(screen)
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_nothing_to_save())).toBeVisible()
  expect(setFn).not.toHaveBeenCalled()
})

test('after a blank refusal, filling a field lets the save through', async () => {
  const { screen } = await renderWithProviders(dialog())
  await openHome(screen)
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_nothing_to_save())).toBeVisible()
  await screen.getByRole('button', { name: SET_VIN }).click()
  await screen.getByLabelText(VIN, { exact: true }).fill('TMBJJ7NE8L0123456')
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
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await screen.getByLabelText(API_KEY, { exact: true }).fill('new-key')
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
  await screen.getByRole('button', { name: SET_VIN }).click()
  await screen.getByLabelText(VIN, { exact: true }).fill('x')
  await openHome(screen)
  await screen.getByLabelText(HOME, { exact: true }).fill('y')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).toBeVisible()
  await expect.element(screen.getByText(m.charging_credentials_invalid_home())).toBeVisible()
  // Focus moves to the first rejected field once the submit has ended.
  await expect.element(screen.getByLabelText(VIN, { exact: true })).toHaveFocus()
  expect(onChanged).not.toHaveBeenCalled()
  expect(toastMock.error).not.toHaveBeenCalled()
  await screen.getByLabelText(VIN, { exact: true }).fill('xy')
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
  await screen.getByLabelText(API_KEY, { exact: true }).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect
    .element(screen.getByText(m.charging_credentials_reenter_field()).first())
    .toBeVisible()
  expect(screen.getByText(m.charging_credentials_reenter_field()).elements()).toHaveLength(2)
})

test('a failed save toasts, stays open and runs no sync', async () => {
  setFn.mockRejectedValue(new Error('boom'))
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await screen.getByLabelText(API_KEY, { exact: true }).fill('k')
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
  await screen.getByLabelText(API_KEY, { exact: true }).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_credentials_key_missing()),
  )
  expect(toastMock.error).not.toHaveBeenCalledWith(m.charging_credentials_save_error())
  expect(onChanged).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
})

test('missing key: open inputs and reveal buttons disabled, remove still offered', async () => {
  const { screen } = await renderWithProviders(
    dialog({ status: status({ encryptionKeyConfigured: false }) }),
  )
  await expect.element(screen.getByText(m.charging_credentials_key_missing())).toBeVisible()
  await expect.element(screen.getByRole('button', { name: CHOOSE_HOME })).toBeDisabled()
  await expect.element(screen.getByRole('button', { name: REPLACE_API_KEY })).toBeDisabled()
  await expect.element(screen.getByRole('button', { name: SET_VIN })).toBeDisabled()
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
  await screen.getByRole('button', { name: SET_VIN }).click()
  await screen.getByLabelText(VIN, { exact: true }).fill('x')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).toBeVisible()
  await rerender(dialog({ open: false, source: undefined }))
  await expect.element(screen.getByLabelText(VIN, { exact: true })).not.toBeInTheDocument()
  await rerender(dialog())
  // The VIN is closed again; reopened, it is empty.
  await screen.getByRole('button', { name: SET_VIN }).click()
  await expect.element(screen.getByLabelText(VIN, { exact: true })).toHaveValue('')
  await expect
    .element(screen.getByText(m.charging_credentials_invalid_vin()))
    .not.toBeInTheDocument()
})

test('secret inputs ask for a new password and every id is namespaced per source', async () => {
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await screen.getByRole('button', { name: SET_VIN }).click()
  const apiKey = screen.getByLabelText(API_KEY, { exact: true }).element()
  expect(apiKey.getAttribute('autocomplete')).toBe('new-password')
  expect(apiKey.id).toBe('credential-skoda-apiKey')
  expect(apiKey.getAttribute('name')).toBe('credential-skoda-apiKey')
  for (const attr of ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type'])
    expect(apiKey.hasAttribute(attr)).toBe(true)
  const vin = screen.getByLabelText(VIN, { exact: true }).element()
  expect(vin.getAttribute('autocomplete')).toBe('off')
  expect(vin.id).toBe('credential-skoda-vin')
  expect(vin.hasAttribute('data-1p-ignore')).toBe(true)
})

test('the VIN is described by its hints, and after INVALID_FIELD by the error after them', async () => {
  setFn.mockRejectedValue(
    new ORPCError('INVALID_FIELD', { defined: true, data: { fields: ['vin'] } }),
  )
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: SET_VIN }).click()
  const vin = screen.getByLabelText(VIN, { exact: true })
  await expect
    .element(vin)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_hint_vin()))
  await vin.fill('x')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect
    .element(vin)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_invalid_vin()))
  await expect
    .element(vin)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_hint_vin()))
  // Hints first, then the error.
  const ids = vin.element().getAttribute('aria-describedby')?.split(' ') ?? []
  expect(ids.at(-2)).toBe('credential-skoda-vin-description')
  expect(ids.at(-1)).toBe('credential-skoda-vin-error')
})

test('a suspect field is described by its red line, open or closed', async () => {
  const { screen } = await renderWithProviders(dialog({ suspectFields: ['vin'] }))
  const reveal = screen.getByRole('button', { name: SET_VIN })
  await expect
    .element(reveal)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_field_suspect()))
  // …and by its summary, so tabbing straight to the button still says where the value comes from.
  await expect.element(reveal).toHaveAccessibleDescription(expect.stringContaining('SKODA_VIN'))
  await reveal.click()
  await expect
    .element(screen.getByLabelText(VIN, { exact: true }))
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_field_suspect()))
})

test('a blank submit shows an alert and focuses the first open input', async () => {
  const { screen } = await renderWithProviders(dialog())
  await openHome(screen)
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect
    .element(
      screen.getByRole('alert').filter({ hasText: m.charging_credentials_nothing_to_save() }),
    )
    .toBeVisible()
  // The API key and VIN are closed: the home position, opened, is the first input.
  await expect.element(screen.getByLabelText(HOME, { exact: true })).toHaveFocus()
})

test('the dialog cannot be dismissed while a save is pending', async () => {
  setFn.mockReturnValue(new Promise(() => {}))
  const { screen } = await renderWithProviders(dialog())
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await screen.getByLabelText(API_KEY, { exact: true }).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(setFn).toHaveBeenCalled())
  await userEvent.keyboard('{Escape}')
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
  await expect.element(screen.getByRole('dialog')).toBeInTheDocument()
})

test('missing key: focus starts on Cancel; inputs and reveal buttons are described by the alert', async () => {
  const { screen } = await renderWithProviders(
    dialog({ status: status({ encryptionKeyConfigured: false }) }),
  )
  await expect
    .element(screen.getByRole('button', { name: m.common_close(), exact: true }))
    .toHaveFocus()
  await expect
    .element(screen.getByRole('button', { name: CHOOSE_HOME }))
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_key_missing()))
  await expect
    .element(screen.getByRole('button', { name: REPLACE_API_KEY }))
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
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await screen.getByLabelText(API_KEY, { exact: true }).fill('k')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith('skoda'))
  await vi.waitFor(() => {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credentials'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['evCharging'] })
  })
})

test('unreadable: every field opens with the amber badge, never saved or env', async () => {
  // The source fails closed and never falls back to env (ADR-0026): the env and
  // missing fields read unreadable too.
  const { screen } = await renderWithProviders(dialog({ status: status({}, { unreadable: true }) }))
  const badges = screen.getByText(m.charging_credentials_badge_unreadable(), { exact: true })
  await expect.element(badges.first()).toBeVisible()
  expect(badges.elements()).toHaveLength(3)
  for (const name of [API_KEY, VIN, HOME])
    await expect.element(screen.getByLabelText(name, { exact: true })).toBeVisible()
  for (const badge of [
    m.charging_credentials_badge_stored(),
    m.charging_credentials_badge_env(),
    m.charging_credentials_badge_missing(),
  ])
    expect(screen.getByText(badge, { exact: true }).elements()).toHaveLength(0)
  expect(screen.getByText('SKODA_VIN').elements()).toHaveLength(0)
  // Every field must be re-entered: none can be closed again.
  for (const name of [API_KEY, VIN, HOME])
    expect(screen.getByRole('button', { name: closeName(name) }).elements()).toHaveLength(0)
})

test('the form posts, so a native submit never puts values in the URL', async () => {
  const { screen } = await renderWithProviders(dialog())
  await openHome(screen)
  const form = screen.getByLabelText(HOME, { exact: true }).element().closest('form')
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
    .toMatchTextContent(m.charging_credentials_remove_confirm_grid())
})

function skodaStatus(fields: SkodaFields) {
  return status({}, { fields })
}
const MISSING = { origin: 'missing', envSet: false } as const

async function openRemoveConfirm(source: CredentialSource, s: CredentialStatus) {
  const { screen } = await renderWithProviders(dialog({ source, status: s }))
  await screen.getByRole('button', { name: m.charging_credentials_remove() }).click()
  return screen.getByRole('alertdialog')
}

test('the remove confirm names the saved fields and says the app falls back to env', async () => {
  const confirm = await openRemoveConfirm(
    'skoda',
    skodaStatus({
      apiKey: { origin: 'stored', envSet: true },
      vin: { origin: 'stored', envSet: true },
      homeCoordinates: MISSING,
    }),
  )
  await expect
    .element(
      confirm.getByText(
        m.charging_credentials_remove_confirm({ source: 'Škoda', fields: 'API-nyckel och VIN' }),
      ),
    )
    .toBeVisible()
  await expect
    .element(confirm)
    .toHaveAccessibleDescription(
      expect.stringContaining(m.charging_credentials_remove_falls_back()),
    )
})

test('a single saved field is named alone', async () => {
  const confirm = await openRemoveConfirm(
    'skoda',
    skodaStatus({
      apiKey: MISSING,
      vin: { origin: 'stored', envSet: false },
      homeCoordinates: MISSING,
    }),
  )
  await expect
    .element(confirm)
    .toHaveAccessibleDescription(
      expect.stringContaining(
        m.charging_credentials_remove_confirm({ source: 'Škoda', fields: 'VIN' }),
      ),
    )
})

test('with no env vars the remove confirm says the source stops syncing', async () => {
  const confirm = await openRemoveConfirm(
    'skoda',
    skodaStatus({
      apiKey: { origin: 'stored', envSet: false },
      vin: { origin: 'stored', envSet: false },
      homeCoordinates: MISSING,
    }),
  )
  await expect
    .element(confirm)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_remove_stops()))
})

test('only the optional home position in env does not count as falling back', async () => {
  const confirm = await openRemoveConfirm(
    'skoda',
    skodaStatus({
      apiKey: { origin: 'stored', envSet: false },
      vin: { origin: 'stored', envSet: false },
      homeCoordinates: { origin: 'env', envSet: true },
    }),
  )
  await expect
    .element(confirm)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_remove_stops()))
})

test('a non-Škoda source names its own fields; partial env says it is not enough', async () => {
  const s = status()
  s.sources.emaldo = {
    fields: {
      user: { origin: 'stored', envSet: false },
      password: { origin: 'stored', envSet: false },
      appId: { origin: 'env', envSet: true },
      appSecret: { origin: 'env', envSet: true },
    },
    updatedAt: SAVED,
    unreadable: false,
  }
  const confirm = await openRemoveConfirm('emaldo', s)
  await expect.element(confirm).toHaveAccessibleDescription(
    expect.stringContaining(
      m.charging_credentials_remove_confirm({
        source: integrationSourceName('emaldo'),
        fields: credentialFieldList('emaldo', ['user', 'password']),
      }),
    ),
  )
  await expect
    .element(confirm)
    .toHaveAccessibleDescription(
      expect.stringContaining(m.charging_credentials_remove_env_incomplete()),
    )
})

test('an unreadable source lists no fields', async () => {
  const confirm = await openRemoveConfirm('skoda', status({}, { unreadable: true }))
  await expect
    .element(confirm)
    .toHaveAccessibleDescription(
      expect.stringContaining(
        m.charging_credentials_remove_confirm_unreadable({ source: 'Škoda' }),
      ),
    )
})

test('the grid remove confirm says the monthly check is skipped without env', async () => {
  const s = status()
  s.sources.gridTariff = {
    fields: { facilityId: { origin: 'stored', envSet: false } },
    updatedAt: SAVED,
    unreadable: false,
  }
  const confirm = await openRemoveConfirm('gridTariff', s)
  await expect
    .element(confirm)
    .toHaveAccessibleDescription(
      expect.stringContaining(m.charging_credentials_remove_confirm_grid()),
    )
  await expect
    .element(confirm)
    .toHaveAccessibleDescription(
      expect.stringContaining(m.charging_credentials_remove_stops_grid()),
    )
})

test('the grid remove confirm says the env var is used again when it is set', async () => {
  const s = status()
  s.sources.gridTariff = {
    fields: { facilityId: { origin: 'stored', envSet: true } },
    updatedAt: SAVED,
    unreadable: false,
  }
  const confirm = await openRemoveConfirm('gridTariff', s)
  await expect
    .element(confirm)
    .toHaveAccessibleDescription(
      expect.stringContaining(m.charging_credentials_remove_falls_back_one()),
    )
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
  await screen.getByRole('button', { name: SET_VIN }).click()
  await screen.getByLabelText(VIN, { exact: true }).fill('x')
  await openHome(screen)
  await screen.getByLabelText(HOME, { exact: true }).fill('y')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect.element(screen.getByText(m.charging_credentials_invalid_vin())).toBeVisible()
  // Typing the rejected value back no longer brings its error back: it was dropped.
  await screen.getByLabelText(VIN, { exact: true }).fill('xy')
  await screen.getByLabelText(VIN, { exact: true }).fill('x')
  await expect
    .element(screen.getByText(m.charging_credentials_invalid_vin()))
    .not.toBeInTheDocument()
  await expect.element(screen.getByText(m.charging_credentials_invalid_home())).toBeVisible()
})

test('an open input is described by its badge first', async () => {
  const { screen } = await renderWithProviders(dialog())
  await openHome(screen)
  const home = screen.getByLabelText(HOME, { exact: true })
  await expect
    .element(home)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_badge_missing()))
  expect(home.element().getAttribute('aria-describedby')?.split(' ')[0]).toBe(
    'credential-skoda-homeCoordinates-badge',
  )
})

test('an unreadable input says so when tabbed into', async () => {
  const { screen } = await renderWithProviders(dialog({ status: status({}, { unreadable: true }) }))
  await expect
    .element(screen.getByLabelText(API_KEY, { exact: true }))
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_credentials_badge_unreadable()))
})

test('a status refetch keeps a revealed input open; only Avbryt closes and clears it', async () => {
  const { screen, queryClient } = await renderWithProviders(dialog())
  const rerender = (ui: ReactNode) =>
    screen.rerender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
  // The API key goes missing (removed elsewhere): it opens and is typed into…
  const apiKeyMissing = status(
    {},
    {
      fields: {
        apiKey: { origin: 'missing', envSet: false },
        vin: { origin: 'env', envSet: true },
        homeCoordinates: { origin: 'missing', envSet: false },
      },
    },
  )
  await rerender(dialog({ status: apiKeyMissing }))
  await screen.getByLabelText(API_KEY, { exact: true }).fill('typed-then-stored')
  // …then is stored again: the input stays open with the typing, now closable.
  await rerender(dialog())
  await expect
    .element(screen.getByLabelText(API_KEY, { exact: true }))
    .toHaveValue('typed-then-stored')
  await screen.getByRole('button', { name: closeName(API_KEY) }).click()
  await expect.element(screen.getByLabelText(API_KEY, { exact: true })).not.toBeInTheDocument()
  // A reveal starts empty.
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await expect.element(screen.getByLabelText(API_KEY, { exact: true })).toHaveValue('')
  await screen.getByRole('button', { name: closeName(API_KEY) }).click()
  await openHome(screen)
  await screen.getByLabelText(HOME, { exact: true }).fill('59.33,18.07')
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await vi.waitFor(() => expect(setFn).toHaveBeenCalled())
  expect(setFn.mock.calls[0][0]).toEqual({
    source: 'skoda',
    fields: { homeCoordinates: '59.33,18.07' },
  })
})

test('Avbryt clears a "fill in at least one field" refusal', async () => {
  const { screen } = await renderWithProviders(dialog({ status: status({}, { fields: ALL_SET }) }))
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await screen.getByRole('button', { name: m.common_save(), exact: true }).click()
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent(m.charging_credentials_nothing_to_save())
  await screen.getByRole('button', { name: closeName(API_KEY) }).click()
  await expect
    .element(screen.getByText(m.charging_credentials_nothing_to_save()))
    .not.toBeInTheDocument()
})

test('with every field closed, focus starts on the first reveal button', async () => {
  const { screen } = await renderWithProviders(dialog({ status: status({}, { fields: ALL_SET }) }))
  await expect.element(screen.getByRole('button', { name: REPLACE_API_KEY })).toHaveFocus()
})

test('closing a field once the key is gone sends focus to Cancel, not a disabled button', async () => {
  const { screen, queryClient } = await renderWithProviders(dialog())
  const rerender = (ui: ReactNode) =>
    screen.rerender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
  await screen.getByRole('button', { name: REPLACE_API_KEY }).click()
  await rerender(dialog({ status: status({ encryptionKeyConfigured: false }) }))
  await screen.getByRole('button', { name: closeName(API_KEY) }).click()
  await expect.element(screen.getByRole('button', { name: REPLACE_API_KEY })).toBeDisabled()
  await expect
    .element(screen.getByRole('button', { name: m.common_close(), exact: true }))
    .toHaveFocus()
})

test('a closed missing home position says what it is for', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect
    .element(screen.getByText(m.charging_credentials_home_missing_summary()))
    .toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: CHOOSE_HOME }))
    .toHaveAccessibleDescription(
      expect.stringContaining(m.charging_credentials_home_missing_summary()),
    )
})

test('the coordinates hint follows the input, which stays described by it', async () => {
  const { screen } = await renderWithProviders(dialog())
  await openHome(screen)
  const input = screen.getByLabelText(HOME, { exact: true })
  const hint = screen.getByText(m.charging_home_coordinates_hint())
  expect(
    input.element().compareDocumentPosition(hint.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0)
  await expect
    .element(input)
    .toHaveAccessibleDescription(expect.stringContaining(m.charging_home_coordinates_hint()))
})
