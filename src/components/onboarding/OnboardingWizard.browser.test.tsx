import { expect, test, vi } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { OnboardingWizard } from './OnboardingWizard'

// `vi.mock` factories are hoisted above the file, so state they close over must
// live in `vi.hoisted` (also hoisted) rather than an ordinary top-level `let`
// (codebase idiom — see heicTranscode.test.ts). `getRouteApi` is mocked wholesale
// so the wizard never needs a real Router/RouterProvider (component tests in
// this project are router-free — see test/browser/render.tsx) — each test just
// points `search.step` at the step it wants rendered.
const { search, navigate } = vi.hoisted(() => ({
  search: { step: 'name' as 'name' | 'avatar' },
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    getRouteApi: () => ({
      useSearch: () => search,
      useNavigate: () => navigate,
    }),
  }
})

// The wizard chrome renders <ModeToggle>, which needs a ThemeProvider this
// leaf-focused render doesn't set up — same fix as ModeToggle's own test.
vi.mock('~/components/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: () => {} }),
}))

type Me = RouterOutputs['user']['me']

const fakeMe: Me = {
  id: 'user-1',
  name: 'Alice Svensson',
  email: 'alice@example.se',
  emailVerified: true,
  image: 'https://example.com/avatar.png',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  role: 'user',
  banned: false,
  banReason: null,
  banExpires: null,
  phone: null,
  deletedAt: null,
  imageBlurhash: null,
  onboardedAt: null,
}

function seededClient() {
  const queryClient = makeTestQueryClient()
  queryClient.setQueryData(orpc.user.me.queryKey(), fakeMe)
  return queryClient
}

test('the wizard opens on the name step, step 1 of exactly 2', async () => {
  search.step = 'name'
  const { screen } = await renderWithProviders(<OnboardingWizard />, {
    queryClient: seededClient(),
  })

  await expect.element(screen.getByLabelText(m.onboarding_name_label())).toBeVisible()
  // The step-dots status region has no text/native content of its own (just
  // empty <span> dots), so it renders with a 0×0 box under this project's
  // CSS-free component-test setup (no Tailwind plugin — see
  // vitest.browser.config.ts) — assert DOM presence, not paint visibility.
  await expect
    .element(
      screen.getByRole('status', {
        name: m.onboarding_step_progress({ current: 1, total: 2 }),
      }),
    )
    .toBeInTheDocument()
})

test('avatar is the final step (2 of 2) — the phone step is gone', async () => {
  search.step = 'avatar'
  const { screen } = await renderWithProviders(<OnboardingWizard />, {
    queryClient: seededClient(),
  })

  await expect
    .element(
      screen.getByRole('status', {
        name: m.onboarding_step_progress({ current: 2, total: 2 }),
      }),
    )
    .toBeInTheDocument()
  // Only 'name' | 'avatar' exist in the step union now — going straight from
  // name (step 1) to avatar (step 2, "of 2") proves there's no phone step in
  // between. A phone input would be the only tel-type field the wizard could
  // render; confirm none is present.
  expect(screen.container.querySelector('input[type="tel"]')).toBeNull()
})

test('the final (avatar) step shows the finish label, not "Next"', async () => {
  search.step = 'avatar'
  const { screen } = await renderWithProviders(<OnboardingWizard />, {
    queryClient: seededClient(),
  })

  await expect.element(screen.getByRole('button', { name: m.onboarding_finish() })).toBeVisible()
  expect(screen.getByRole('button', { name: m.onboarding_next() }).elements()).toHaveLength(0)
})
