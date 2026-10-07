import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { RouterOutputs } from '~/lib/orpc/client'
import { orpc } from '~/lib/orpc/client'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { AvatarUpload } from './AvatarUpload'

// The heavy modules are mocked: the test pins that a pick still reads the file and
// runs the upload flow once they arrive through the component's dynamic import.
const mocks = vi.hoisted(() => ({
  readImageMetaFromFile: vi.fn(async () => ({ gps: null, thumbnail: null })),
  runUploadFlow: vi.fn(async () => {}),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('~/lib/files/exif', () => ({ readImageMetaFromFile: mocks.readImageMetaFromFile }))
vi.mock('~/lib/effects/storage/clientUpload', () => ({ runUploadFlow: mocks.runUploadFlow }))
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

test('a picked image is read and uploaded through the lazily loaded modules', async () => {
  const queryClient = makeTestQueryClient()
  queryClient.setQueryData(orpc.user.me.queryKey(), fakeMe)
  const { screen } = await renderWithProviders(<AvatarUpload />, { queryClient })

  // No button click first: a pick must work even if the warm-up never ran.
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' })
  await userEvent.upload(input, file)

  await expect.poll(() => mocks.runUploadFlow.mock.calls.length).toBe(1)
  expect(mocks.readImageMetaFromFile).toHaveBeenCalledWith(file)
  expect(mocks.runUploadFlow).toHaveBeenCalledWith(
    file,
    expect.objectContaining({ access: 'public', contentType: 'image/png' }),
  )
  await expect.poll(() => mocks.toastSuccess.mock.calls.length).toBe(1)
  expect(mocks.toastError).not.toHaveBeenCalled()
})
