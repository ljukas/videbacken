import { toast } from 'sonner'
import { z } from 'zod'
import { FieldGroup } from '~/components/ui/field'
import { useAppForm } from '~/hooks/form'
import { authClient } from '~/lib/authClient'
import { m } from '~/paraglide/messages'

const loginSchema = z.object({
  email: z.email(),
})

type Props = {
  onSent: (email: string) => void
  callbackURL: string
}

export function LoginFormCard({ onSent, callbackURL }: Props) {
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
              variant="default"
              size="xl"
              className="w-full font-normal"
            />
          </form.AppForm>
        </form>
      </div>
    </div>
  )
}
