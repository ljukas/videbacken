import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { authClient } from '~/lib/authClient'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { GoogleIcon } from './GoogleIcon'

type Props = {
  callbackURL: string
  className?: string
}

// Shared by LoginFormCard (primary sign-in surface) and WelcomeBackCard
// (secondary option alongside the one-click magic-link resend) so both
// stay wired to the exact same `signIn.social` call and error handling.
export function GoogleSignInButton({ callbackURL, className }: Props) {
  const [isPending, setIsPending] = useState(false)

  async function signInWithGoogle() {
    setIsPending(true)
    const { error } = await authClient.signIn.social({ provider: 'google', callbackURL })
    if (error) {
      // On success the browser navigates away to Google, so isPending never
      // needs resetting in that branch — only the error path returns here.
      setIsPending(false)
      toast.error(error.message ?? m.login_send_error())
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="xl"
      className={cn('w-full font-normal', className)}
      disabled={isPending}
      onClick={() => {
        void signInWithGoogle()
      }}
    >
      {isPending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <GoogleIcon data-icon="inline-start" className="size-4" />
      )}
      {m.login_google_button()}
    </Button>
  )
}
