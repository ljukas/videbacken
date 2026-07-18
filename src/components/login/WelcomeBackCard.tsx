import { useState } from 'react'
import { toast } from 'sonner'
import { GoogleSignInButton } from '~/components/login/GoogleSignInButton'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Button } from '~/components/ui/button'
import { Separator } from '~/components/ui/separator'
import { Spinner } from '~/components/ui/spinner'
import { authClient } from '~/lib/authClient'
import type { LoginMethod } from '~/lib/lastLoginMethodFns'
import { initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

// Links the "last used" caption to whichever button it describes (aria-describedby).
const LAST_USED_HINT_ID = 'welcome-back-last-used'

type Props = {
  email: string
  // Resolved server-side by the login loader from the cookie's email — kept
  // out of the cookie itself so it never goes stale.
  name: string | null
  image: string | null
  imageBlurhash: string | null
  // Which method this browser last successfully signed in with; promotes that
  // button to the primary (filled, first) action. null → magic-link default.
  lastMethod: LoginMethod | null
  onSent: (email: string) => void
  onSwitchUser: () => void
  // Magic link opens in a new tab and lands on /signed-in; Google stays in this
  // tab and goes straight to the destination. See src/routes/login.tsx.
  magicLinkCallbackURL: string
  googleCallbackURL: string
}

export function WelcomeBackCard({
  email,
  name,
  image,
  imageBlurhash,
  lastMethod,
  onSent,
  onSwitchUser,
  magicLinkCallbackURL,
  googleCallbackURL,
}: Props) {
  const [isSending, setIsSending] = useState(false)
  const googleIsPrimary = lastMethod === 'google'

  async function sendMagicLink() {
    setIsSending(true)
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: magicLinkCallbackURL,
    })
    setIsSending(false)
    if (error) {
      toast.error(error.message ?? m.login_send_error())
      return
    }
    onSent(email)
  }

  const magicLinkButton = (
    <Button
      type="button"
      variant={googleIsPrimary ? 'outline' : 'default'}
      size="xl"
      className="w-full font-normal"
      disabled={isSending}
      aria-describedby={googleIsPrimary ? undefined : LAST_USED_HINT_ID}
      onClick={() => {
        void sendMagicLink()
      }}
    >
      {isSending && <Spinner data-icon="inline-start" />}
      {isSending ? m.login_submit_pending() : m.login_submit()}
    </Button>
  )

  const googleButton = (
    <GoogleSignInButton
      callbackURL={googleCallbackURL}
      variant={googleIsPrimary ? 'default' : 'outline'}
      aria-describedby={googleIsPrimary ? LAST_USED_HINT_ID : undefined}
    />
  )

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="font-heading font-semibold text-2xl tracking-tight">
        {m.login_welcome_back_title()}
      </h1>

      <div className="flex max-w-full items-center gap-2.5 rounded-full border bg-background/60 py-1 pr-4 pl-1">
        <Avatar className="size-8 shrink-0">
          {image ? (
            <AvatarImage src={image} alt={email} width={32} height={32} blurhash={imageBlurhash} />
          ) : null}
          <AvatarFallback className="font-semibold text-xs">
            {name?.trim() ? initials(name) : (email[0]?.toUpperCase() ?? '?')}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 truncate font-medium text-sm">{email}</span>
      </div>

      <div className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span id={LAST_USED_HINT_ID} className="text-center text-muted-foreground text-xs">
            {m.login_last_used()}
          </span>
          {googleIsPrimary ? googleButton : magicLinkButton}
        </div>

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs uppercase">{m.common_or()}</span>
          <Separator className="flex-1" />
        </div>

        {googleIsPrimary ? magicLinkButton : googleButton}

        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-muted-foreground text-sm"
          onClick={onSwitchUser}
        >
          {m.login_switch_user()}
        </Button>
      </div>
    </div>
  )
}
