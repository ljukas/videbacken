import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { OnboardingWizard } from '~/components/onboarding/OnboardingWizard'
import { getSession } from '~/lib/getSession'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// Step lives in the URL (ADR-0013) so browser back/forward work and a mid-flow
// refresh stays put. `.catch` defaults a missing/invalid value to the first step.
const onboardingSearchSchema = z.object({
  step: z.enum(['name', 'phone', 'avatar', 'passkey']).catch('name'),
})

// Top-level (not under _authenticated) so the wizard renders full-screen with no
// app shell — like /login. Invitees are sent here by the _authenticated loader
// while `onboardedAt` is null; this route is where they fill in their details.
// See ADR-0017.
export const Route = createFileRoute('/onboarding')({
  validateSearch: onboardingSearchSchema,
  beforeLoad: async () => {
    const session = await getSession()
    if (!session || session.user.deletedAt) {
      throw redirect({ to: '/login', search: { redirect: '/onboarding' } })
    }
  },
  loaderDeps: ({ search }) => ({ step: search.step }),
  loader: async ({ context: { queryClient }, deps }) => {
    // Fresh me (orpc.user.me bypasses the cookie cache). Already onboarded →
    // skip the wizard. This also primes the cache the wizard steps read.
    const me = await queryClient.ensureQueryData(orpc.user.me.queryOptions())
    if (me.onboardedAt != null) throw redirect({ to: '/' })
    // Name is the only required step. A user who jumps straight to a later step
    // via the URL (?step=avatar) could otherwise finish with the email
    // placeholder name still in place — bounce them back to the name step.
    // `name === email` is the local "no real name yet" signal; never redirect
    // away from the name step itself, or this loops.
    if (me.name === me.email && deps.step !== 'name') {
      throw redirect({ to: '/onboarding', search: { step: 'name' } })
    }
    return me
  },
  head: () => ({ meta: seo({ title: m.onboarding_meta_title() }) }),
  component: OnboardingWizard,
})
