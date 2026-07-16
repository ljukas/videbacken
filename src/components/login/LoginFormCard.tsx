import { KeyRoundIcon } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '~/components/ui/button'
import { FieldGroup } from '~/components/ui/field'
import { Separator } from '~/components/ui/separator'
import { Spinner } from '~/components/ui/spinner'
import { useAppForm } from '~/hooks/form'
import { usePasskeySupport } from '~/hooks/usePasskeys'
import { authClient } from '~/lib/authClient'
import { m } from '~/paraglide/messages'

const loginSchema = z.object({
  email: z.email(),
})

type Props = {
  onSent: (email: string) => void
  callbackURL: string
  onPasskeySignIn: () => void
  passkeyPending: boolean
}

export function LoginFormCard({ onSent, callbackURL, onPasskeySignIn, passkeyPending }: Props) {
  const passkeySupported = usePasskeySupport()
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onSubmit: loginSchema },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.signIn.magicLink({
        email: value.email,
        callbackURL,
      })
      if (error) {
        toast.error(error.message ?? m.login_send_error())
        return
      }
      onSent(value.email)
    },
  })

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-1.5 text-center">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">{m.login_title()}</h1>
        <p className="text-balance text-muted-foreground text-sm">{m.login_description()}</p>
      </header>

      <div className="flex flex-col gap-5">
        {passkeySupported && (
          <>
            <Button
              type="button"
              size="xl"
              className="w-full font-normal"
              disabled={passkeyPending}
              onClick={onPasskeySignIn}
            >
              {passkeyPending ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon />}
              {m.login_passkey_button()}
            </Button>
            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-muted-foreground text-xs">{m.common_or()}</span>
              <Separator className="flex-1" />
            </div>
          </>
        )}

        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.AppField
              name="email"
              children={(field) => (
                <field.FloatingTextField
                  label={m.login_email_label()}
                  type="email"
                  autoComplete="username"
                />
              )}
            />
          </FieldGroup>

          <form.AppForm>
            <form.SubmitButton
              label={m.login_submit()}
              pendingLabel={m.login_submit_pending()}
              variant={passkeySupported ? 'outline' : 'default'}
              size="xl"
              className="w-full font-normal"
            />
          </form.AppForm>
        </form>
      </div>
    </div>
  )
}
