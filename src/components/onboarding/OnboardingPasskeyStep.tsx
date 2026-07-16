import { ArrowLeftIcon, KeyRoundIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { useAddPasskey, usePasskeySupport } from '~/hooks/usePasskeys'
import { suppressPasskeyPrompt } from '~/lib/passkeyPrompt'
import { m } from '~/paraglide/messages'

type Props = {
  onFinish: () => void
  onBack: () => void
  finishing: boolean
}

export function OnboardingPasskeyStep({ onFinish, onBack, finishing }: Props) {
  // Final wizard step. `useAddPasskey` opens the OS WebAuthn dialog; on success we
  // toast and complete onboarding (onFinish stamps onboardedAt + navigates to /).
  // The hook silently swallows a user-cancelled prompt (NotAllowedError) and toasts
  // other errors, so a cancel just leaves the user here to retry or skip.
  const isSupported = usePasskeySupport()
  const addPasskey = useAddPasskey({
    onAdded: () => {
      toast.success(m.passkey_added())
      onFinish()
    },
  })
  const busy = addPasskey.isPending || finishing

  // Skipping here is a "not now" — start the same per-device snooze the home-page prompt
  // uses, so it doesn't pop the instant we land on / but re-nudges later (see ADR-0017).
  const skip = () => {
    suppressPasskeyPrompt()
    onFinish()
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-1.5 text-center">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">
          {m.passkey_setup_title()}
        </h1>
        <p className="text-balance text-muted-foreground text-sm">
          {m.passkey_setup_description()}
        </p>
      </header>

      <div className="flex flex-col gap-5">
        {isSupported ? (
          <Button
            type="button"
            size="xl"
            className="w-full font-normal"
            onClick={() => addPasskey.mutate()}
            disabled={busy}
          >
            {addPasskey.isPending ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon />}
            {m.passkey_setup_create()}
          </Button>
        ) : (
          // No WebAuthn on this browser: nothing to create, so the primary action
          // just completes onboarding.
          <Button
            type="button"
            size="xl"
            className="w-full font-normal"
            onClick={onFinish}
            disabled={busy}
          >
            {finishing ? <Spinner data-icon="inline-start" /> : null}
            {m.onboarding_finish()}
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon />
          {m.common_back()}
        </Button>
        {isSupported ? (
          <Button type="button" variant="ghost" onClick={skip} disabled={busy}>
            {m.onboarding_skip()}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
