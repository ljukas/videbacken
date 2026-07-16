import { useState } from 'react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { authClient } from '~/lib/authClient'
import { initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type Props = {
  email: string
  // Resolved server-side by the login loader from the cookie's email — kept
  // out of the cookie itself so it never goes stale.
  name: string | null
  image: string | null
  imageBlurhash: string | null
  onSent: (email: string) => void
  onSwitchUser: () => void
  callbackURL: string
}

export function WelcomeBackCard({
  email,
  name,
  image,
  imageBlurhash,
  onSent,
  onSwitchUser,
  callbackURL,
}: Props) {
  const [isSending, setIsSending] = useState(false)

  async function sendMagicLink() {
    setIsSending(true)
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL,
    })
    setIsSending(false)
    if (error) {
      toast.error(error.message ?? m.login_send_error())
      return
    }
    onSent(email)
  }

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
        <Button
          type="button"
          variant="default"
          size="xl"
          className="w-full font-normal"
          disabled={isSending}
          onClick={() => {
            void sendMagicLink()
          }}
        >
          {isSending && <Spinner data-icon="inline-start" />}
          {isSending ? m.login_submit_pending() : m.login_submit()}
        </Button>

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
