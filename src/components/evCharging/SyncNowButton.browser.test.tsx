import { beforeEach, expect, test, vi } from 'vitest'
import { integrationErrorMessage } from '~/lib/integrationHealthMessage'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { SyncNowButton, useSyncNow } from './SyncNowButton'

// Mock the oRPC client so clicking resolves with a scripted `syncNow` result
// instead of hitting the network (same idiom as EditDeviceDialog's test);
// spreading `opts` keeps the hook's onSuccess/onError/onSettled.
const { syncFn, toastMock } = vi.hoisted(() => ({
  syncFn: vi.fn(),
  toastMock: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    evCharging: {
      syncNow: {
        mutationOptions: (opts: Record<string, unknown>) => ({ ...opts, mutationFn: syncFn }),
      },
      key: () => ['evCharging'],
    },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

beforeEach(() => {
  syncFn.mockReset()
  for (const fn of Object.values(toastMock)) fn.mockReset()
})

type Result = {
  outcome: 'ok' | 'skipped' | 'failed' | 'error'
  code: string | null
  upserted: number
}
const OK: Result = { outcome: 'ok', code: null, upserted: 96 }
type Source = 'zaptec' | 'elpris' | 'skoda' | 'emaldo'

// `syncNow` is called once per source; script each source's result.
function respond(results: {
  zaptec?: Result | Error
  elpris?: Result | Error
  skoda?: Result | Error
  emaldo?: Result | Error
}) {
  syncFn.mockImplementation(async ({ source }: { source: Source }) => {
    const r = results[source] ?? OK
    if (r instanceof Error) throw r
    return r
  })
}

function Harness({ only }: { only?: Source }) {
  const { syncAll, syncSource, isPending } = useSyncNow()
  return <SyncNowButton onSync={only ? () => syncSource(only) : syncAll} pending={isPending} />
}

const click = (screen: Awaited<ReturnType<typeof renderWithProviders>>['screen']) =>
  screen.getByRole('button', { name: m.charging_sync_now() }).click()

test('sync all runs sessions, prices and house energy, toasts the session result once and invalidates evCharging', async () => {
  respond({ zaptec: { outcome: 'ok', code: null, upserted: 3 } })
  const queryClient = makeTestQueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const { screen } = await renderWithProviders(<Harness />, { queryClient })

  await click(screen)

  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_ok({ count: 3 })),
  )
  await vi.waitFor(() => expect(syncFn).toHaveBeenCalledTimes(3))
  expect(syncFn.mock.calls.map((c) => c[0])).toEqual([
    { source: 'zaptec' },
    { source: 'elpris' },
    { source: 'emaldo' },
  ])
  await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['evCharging'] }))
  // A full sync doesn't stack a second green toast for prices.
  expect(toastMock.success).toHaveBeenCalledOnce()
  expect(toastMock.error).not.toHaveBeenCalled()
})

test('a one-session run toasts the singular', async () => {
  respond({ zaptec: { outcome: 'ok', code: null, upserted: 1 } })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith('Synkningen är klar (1 session uppdaterad)'),
  )
})

test('a failed session run toasts the localized Zaptec error for its code', async () => {
  respond({ zaptec: { outcome: 'failed', code: 'auth_failed', upserted: 0 } })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_failed(), {
      description: integrationErrorMessage('auth_failed', { source: 'zaptec' }),
    }),
  )
})

test('a skipped session run says a sync is already running', async () => {
  respond({ zaptec: { outcome: 'skipped', code: null, upserted: 0 } })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() => expect(toastMock.info).toHaveBeenCalledWith(m.charging_sync_skipped()))
})

test('a failed price sync gets its own error toast next to a session success', async () => {
  respond({
    zaptec: { outcome: 'ok', code: null, upserted: 2 },
    elpris: { outcome: 'failed', code: 'unreachable', upserted: 0 },
  })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_ok({ count: 2 })),
  )
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_prices_failed(), {
      description: integrationErrorMessage('unreachable', { source: 'elpris' }),
    }),
  )
})

test('a transport error is attributed to the source that raised it', async () => {
  respond({ zaptec: { outcome: 'ok', code: null, upserted: 2 }, elpris: new Error('boom') })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_prices_failed(), {
      description: integrationErrorMessage('internal_error', { source: 'elpris' }),
    }),
  )
  expect(toastMock.error).toHaveBeenCalledOnce()
  expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_ok({ count: 2 }))
})

test('retrying prices alone runs only elpris and confirms success', async () => {
  respond({})
  const { screen } = await renderWithProviders(<Harness only="elpris" />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_prices_ok()),
  )
  expect(syncFn.mock.calls.map((c) => c[0])).toEqual([{ source: 'elpris' }])
})

test('a price retry reports a skipped run', async () => {
  respond({ elpris: { outcome: 'skipped', code: null, upserted: 0 } })
  const { screen } = await renderWithProviders(<Harness only="elpris" />)
  await click(screen)
  await vi.waitFor(() => expect(toastMock.info).toHaveBeenCalledWith(m.charging_sync_skipped()))
})

test('a full sync keeps a skipped price run silent', async () => {
  respond({
    zaptec: { outcome: 'ok', code: null, upserted: 1 },
    elpris: { outcome: 'skipped', code: null, upserted: 0 },
  })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() => expect(syncFn).toHaveBeenCalledTimes(3))
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledOnce())
  expect(toastMock.info).not.toHaveBeenCalled()
})

test('the button is disabled while a sync is pending', async () => {
  const { screen } = await renderWithProviders(<SyncNowButton onSync={() => {}} pending />)
  await expect.element(screen.getByRole('button', { name: m.charging_sync_now() })).toBeDisabled()
})

test('retrying the car alone runs only skoda, confirms success and leaves the heading pending state alone', async () => {
  let release: (r: Result) => void = () => {}
  syncFn.mockImplementation(
    () =>
      new Promise<Result>((resolve) => {
        release = resolve
      }),
  )
  function CarHarness() {
    const { syncSource, isPending, isPendingFor } = useSyncNow()
    return (
      <>
        <button type="button" onClick={() => syncSource('skoda')}>
          car
        </button>
        <output data-testid="state">{`${isPending}/${isPendingFor('skoda')}`}</output>
      </>
    )
  }
  const { screen } = await renderWithProviders(<CarHarness />)
  await screen.getByRole('button', { name: 'car' }).click()
  await vi.waitFor(() => expect(syncFn.mock.calls.map((c) => c[0])).toEqual([{ source: 'skoda' }]))
  await expect.element(screen.getByTestId('state')).toMatchTextContent('false/true')
  release(OK)
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_skoda_ok()))
  await expect.element(screen.getByTestId('state')).toMatchTextContent('false/false')
})

test('a failed house sync in a full sync gets its own error toast', async () => {
  respond({
    zaptec: { outcome: 'ok', code: null, upserted: 2 },
    emaldo: { outcome: 'failed', code: 'unreachable', upserted: 0 },
  })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_house_failed(), {
      description: integrationErrorMessage('unreachable', { source: 'emaldo' }),
    }),
  )
  expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_ok({ count: 2 }))
})

test('a full sync keeps an unconfigured Emaldo silent (its health alert says so)', async () => {
  respond({
    zaptec: { outcome: 'ok', code: null, upserted: 1 },
    emaldo: { outcome: 'failed', code: 'not_configured', upserted: 0 },
  })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() => expect(syncFn).toHaveBeenCalledTimes(3))
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledOnce())
  expect(toastMock.error).not.toHaveBeenCalled()
})

test('retrying Emaldo alone runs only emaldo and confirms success', async () => {
  respond({})
  const { screen } = await renderWithProviders(<Harness only="emaldo" />)
  await click(screen)
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_house_ok()))
  expect(syncFn.mock.calls.map((c) => c[0])).toEqual([{ source: 'emaldo' }])
})

test('an explicit Emaldo retry does report not_configured', async () => {
  respond({ emaldo: { outcome: 'failed', code: 'not_configured', upserted: 0 } })
  const { screen } = await renderWithProviders(<Harness only="emaldo" />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_house_failed(), {
      description: integrationErrorMessage('not_configured', { source: 'emaldo' }),
    }),
  )
})

// A house run can take minutes while the backfill runs; the heading must not
// stay disabled behind it. Its own alert shows the pending state.
test('a slow house sync leaves the heading free once sessions and prices settle', async () => {
  let releaseHouse: (r: Result) => void = () => {}
  syncFn.mockImplementation(({ source }: { source: Source }) =>
    source === 'emaldo'
      ? new Promise<Result>((resolve) => {
          releaseHouse = resolve
        })
      : Promise.resolve(OK),
  )
  function HouseHarness() {
    const { syncAll, isPending, isPendingFor } = useSyncNow()
    return (
      <>
        <button type="button" onClick={syncAll}>
          all
        </button>
        <output data-testid="state">{`${isPending}/${isPendingFor('emaldo')}`}</output>
      </>
    )
  }
  const { screen } = await renderWithProviders(<HouseHarness />)
  await screen.getByRole('button', { name: 'all' }).click()
  await expect.element(screen.getByTestId('state')).toMatchTextContent('false/true')
  releaseHouse(OK)
  await expect.element(screen.getByTestId('state')).toMatchTextContent('false/false')
})
