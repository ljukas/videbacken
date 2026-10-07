import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { RouterOutputs } from '~/lib/orpc/client'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { AvatarUpload } from './AvatarUpload'

const mocks = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))
// The chunk can't be fetched (offline, or a deploy replaced its hash). A throwing
// factory is reported by Vitest's mocker as a mocking error rather than rejecting the
// component's import(), so the module loads but its export throws on access instead.
vi.mock('~/lib/effects/storage/clientUpload', () => ({
  get runUploadFlow(): never {
    throw new Error('Failed to fetch dynamically imported module')
  },
}))
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))

type Me = RouterOutputs['user']['me']
const fakeMe: Me = {
  id: 'user-1',
  name: 'Alice Svensson',
  email: 'alice@example.se',
  emailVerified: true,
  image: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  role: 'user',
  banned: false,
  banReason: null,
  banExpires: null,
  phone: null,
  deletedAt: null,
  imageBlurhash: null,
  onboardedAt: new Date('2026-01-02T00:00:00Z'),
}

test('a module that fails to load shows the localized upload error', async () => {
  const queryClient = makeTestQueryClient()
  queryClient.setQueryData(orpc.user.me.queryKey(), fakeMe)
  const { screen } = await renderWithProviders(<AvatarUpload />, { queryClient })

  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' })
  await userEvent.upload(input, file)

  await expect.poll(() => mocks.toastError.mock.calls.length).toBe(1)
  expect(mocks.toastError).toHaveBeenCalledWith(m.avatar_upload_error())
  expect(mocks.toastSuccess).not.toHaveBeenCalled()
  await expect.element(screen.getByRole('button', { name: m.avatar_add_button() })).toBeEnabled()
})
