import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { LocaleSwitcherInline } from '~/components/LocaleSwitcher'
import { Wordmark } from '~/components/Logo'
import { SignedInCard } from '~/components/login/SignedInCard'
import { ModeToggle } from '~/components/ModeToggle'
import { getSession } from '~/lib/getSession'
import { sanitizeRedirect } from '~/lib/utils'

export const Route = createFileRoute('/signed-in')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const safe = sanitizeRedirect(search.redirect)
    return safe ? { redirect: safe } : {}
  },
  beforeLoad: async () => {
    const session = await getSession()
    // Link expired or already consumed — send them back to start over.
    if (!session) throw redirect({ to: '/login' })
  },
  component: SignedIn,
})

function SignedIn() {
  const navigate = useNavigate()
  const { redirect: redirectPath } = Route.useSearch()
  const destination = redirectPath ?? '/'

  function onContinue() {
    void navigate({ to: destination })
  }

  return (
    <div className="brand-wash relative grid min-h-svh place-items-center p-4">
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <LocaleSwitcherInline />
        <ModeToggle />
      </div>
      <div className="flex w-full max-w-sm flex-col items-center gap-8 tracking-normal">
        <Wordmark />
        <SignedInCard onContinue={onContinue} />
      </div>
    </div>
  )
}
