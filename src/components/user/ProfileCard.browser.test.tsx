import { expect, test } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { ProfileCard } from './ProfileCard'

// The exact `user.me` output shape, derived from the router so the seed can't
// drift from what the component reads (type-only import → erased from bundle).
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
  phone: '+46701234567',
  deletedAt: null,
  imageBlurhash: null,
  lastInvitedAt: null,
  onboardedAt: new Date('2026-01-02T00:00:00Z'),
}

// Cache-seed `user.me` (the harness's no-network strategy) so the suspense query
// resolves synchronously from cache — no server, no MSW.
function seededClient() {
  const queryClient = makeTestQueryClient()
  queryClient.setQueryData(orpc.user.me.queryKey(), fakeMe)
  return queryClient
}

test('prefills the name field from the current user', async () => {
  const { screen } = await renderWithProviders(<ProfileCard />, { queryClient: seededClient() })

  await expect.element(screen.getByLabelText(m.user_field_name())).toHaveValue('Alice Svensson')
})

test('shows the email read-only with the immutability hint', async () => {
  const { screen } = await renderWithProviders(<ProfileCard />, { queryClient: seededClient() })

  // Email is no longer an editable input — it's static text with a lock
  // affordance whose accessible name carries the immutability reason (ADR-0017).
  await expect.element(screen.getByText('alice@example.se')).toBeVisible()
  await expect
    .element(screen.getByRole('img', { name: m.account_email_locked_hint() }))
    .toBeVisible()
})

test('the avatar file input uses the HEIC-inclusive accept on non-iOS', async () => {
  const { screen } = await renderWithProviders(<ProfileCard />, { queryClient: seededClient() })

  // ProfileCard embeds <AvatarUpload variant="row">, whose file input gets its
  // `accept` from `imageAccept(useIsIOS())`. In this (non-iOS) Chromium env it must
  // keep HEIC selectable so desktop uploads aren't broken — iOS instead omits heic
  // and relies on the native Photos-picker HEIC→JPEG conversion. Guards the wiring
  // independently of PhotoUploader's identical path.
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]')
  expect(input).not.toBeNull()
  expect(input?.getAttribute('accept') ?? '').toContain('image/heic')
})

test('blocks submit and shows the required error when the name is cleared', async () => {
  const { screen } = await renderWithProviders(<ProfileCard />, { queryClient: seededClient() })

  await screen.getByLabelText(m.user_field_name()).fill('')
  await screen.getByRole('button', { name: m.common_save() }).click()

  await expect.element(screen.getByText(m.validation_name_required())).toBeVisible()
})
