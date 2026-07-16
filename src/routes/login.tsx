import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { LocaleSwitcherInline } from '~/components/LocaleSwitcher'
import { Wordmark } from '~/components/Logo'
import { LoginFormCard } from '~/components/login/LoginFormCard'
import { MagicLinkSentCard } from '~/components/login/MagicLinkSentCard'
import { WelcomeBackCard } from '~/components/login/WelcomeBackCard'
import { ModeToggle } from '~/components/ModeToggle'
import { useAwaitSignIn } from '~/hooks/useAwaitSignIn'
import { useSignInPasskey } from '~/hooks/usePasskeys'
import { clearBrowserSession, getBrowserSession } from '~/lib/browserSessionFns'
import { getSession } from '~/lib/getSession'
import { sanitizeRedirect } from '~/lib/utils'

// The magic link lands in a *new* tab on the /signed-in confirmation page,
// carrying the in-app destination so its "Fortsätt här" fallback knows where to go.
function buildCallbackURL(redirectPath: string | undefined): string {
  const destination = redirectPath ?? '/'
  return `/signed-in?redirect=${encodeURIComponent(destination)}`
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const safe = sanitizeRedirect(search.redirect)
    return safe ? { redirect: safe } : {}
  },
  beforeLoad: async ({ search }) => {
    const session = await getSession()
    if (session) throw redirect({ to: search.redirect ?? '/' })
  },
  loader: async () => {
    const session = await getBrowserSession()
    return {
      savedLogin: session?.email
        ? {
            email: session.email,
            hasPasskey: session.hasPasskey,
            name: session.name,
            image: session.image,
            imageBlurhash: session.imageBlurhash,
          }
        : null,
    }
  },
  component: Login,
})

function Login() {
  const navigate = useNavigate()
  const { redirect: redirectPath } = Route.useSearch()
  const { savedLogin: initialSavedLogin } = Route.useLoaderData()
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [useOther, setUseOther] = useState(false)

  const savedLogin = useOther ? null : initialSavedLogin
  const callbackURL = buildCallbackURL(redirectPath)
  const destination = redirectPath ?? '/'

  // Once the link has been sent, watch for the browser becoming authenticated in
  // the tab the user opens from their inbox, and advance this tab automatically.
  useAwaitSignIn({
    enabled: sentTo !== null,
    onSignedIn: () => {
      navigate({ to: destination })
    },
  })

  const { signIn: signInPasskey, pending: passkeyPending } = useSignInPasskey({
    onSignedIn: () => {
      navigate({ to: destination })
    },
  })

  async function switchToOtherEmail() {
    await clearBrowserSession()
    setUseOther(true)
  }

  return (
    <div className="brand-wash relative grid min-h-svh place-items-center p-4">
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <LocaleSwitcherInline />
        <ModeToggle />
      </div>
      <div className="flex w-full max-w-sm flex-col items-center gap-8 tracking-normal">
        <Wordmark />
        {sentTo ? (
          <MagicLinkSentCard email={sentTo} />
        ) : savedLogin ? (
          <WelcomeBackCard
            email={savedLogin.email}
            hasPasskey={savedLogin.hasPasskey}
            name={savedLogin.name}
            image={savedLogin.image}
            imageBlurhash={savedLogin.imageBlurhash}
            callbackURL={callbackURL}
            onSent={setSentTo}
            onSwitchUser={() => {
              void switchToOtherEmail()
            }}
            onPasskeySignIn={() => void signInPasskey()}
            passkeyPending={passkeyPending}
          />
        ) : (
          <LoginFormCard
            onSent={setSentTo}
            callbackURL={callbackURL}
            onPasskeySignIn={() => void signInPasskey()}
            passkeyPending={passkeyPending}
          />
        )}
      </div>
    </div>
  )
}
