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

function Harness() {
  const { sync, isPending } = useSyncNow()
  return <SyncNowButton onSync={sync} pending={isPending} />
}

test('an ok run toasts success with the upserted count and invalidates evCharging', async () => {
  syncFn.mockResolvedValue({ outcome: 'ok', code: null, upserted: 3 })
  const queryClient = makeTestQueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const { screen } = await renderWithProviders(<Harness />, { queryClient })

  await screen.getByRole('button', { name: m.charging_sync_now() }).click()

  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_ok({ count: 3 })),
  )
  await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['evCharging'] }))
})

test('a one-session run toasts the singular', async () => {
  syncFn.mockResolvedValue({ outcome: 'ok', code: null, upserted: 1 })
  const { screen } = await renderWithProviders(<Harness />)

  await screen.getByRole('button', { name: m.charging_sync_now() }).click()

  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith('Synkningen är klar (1 session uppdaterad)'),
  )
})

test('a failed run toasts the localized error for its code', async () => {
  syncFn.mockResolvedValue({ outcome: 'failed', code: 'auth_failed', upserted: 0 })
  const { screen } = await renderWithProviders(<Harness />)

  await screen.getByRole('button', { name: m.charging_sync_now() }).click()

  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_failed(), {
      description: integrationErrorMessage('auth_failed'),
    }),
  )
})

test('a skipped run says a sync is already running', async () => {
  syncFn.mockResolvedValue({ outcome: 'skipped', code: null, upserted: 0 })
  const { screen } = await renderWithProviders(<Harness />)

  await screen.getByRole('button', { name: m.charging_sync_now() }).click()

  await vi.waitFor(() => expect(toastMock.info).toHaveBeenCalledWith(m.charging_sync_skipped()))
})

test('a transport error toasts a generic failure', async () => {
  syncFn.mockRejectedValue(new Error('network down'))
  const { screen } = await renderWithProviders(<Harness />)

  await screen.getByRole('button', { name: m.charging_sync_now() }).click()

  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_failed(), {
      description: integrationErrorMessage('internal_error'),
    }),
  )
})

test('the button is disabled while a sync is pending', async () => {
  const { screen } = await renderWithProviders(<SyncNowButton onSync={() => {}} pending />)
  await expect.element(screen.getByRole('button', { name: m.charging_sync_now() })).toBeDisabled()
})
