import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import { FieldGroup } from '~/components/ui/field'
import { useAppForm } from '~/hooks/form'
import { logger } from '~/lib/logger/browser'
import { orpc } from '~/lib/orpc/client'
import { nameField } from '~/lib/orpc/userProfileSchema'
import { m } from '~/paraglide/messages'

// Single-field form schema; the name rules live in the shared validator so the
// client and the `user.updateProfile` procedure can't diverge.
const nameSchema = z.object({ name: nameField })

type Props = {
  onNext: () => void
}

export function OnboardingNameStep({ onNext }: Props) {
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())
  const queryClient = useQueryClient()
  const updateMutation = useMutation(orpc.user.updateProfile.mutationOptions())

  const form = useAppForm({
    // Invitees start with name === email (placeholder), so begin blank — they
    // type their real name here. A user re-entering with a real name keeps it.
    defaultValues: { name: me.name === me.email ? '' : me.name },
    validators: { onSubmit: nameSchema },
    onSubmit: async ({ value }) => {
      try {
        await updateMutation.mutateAsync({ name: value.name })
      } catch (error) {
        logger.warn('onboarding name save failed', { error })
        toast.error(m.onboarding_save_error())
        return
      }
      // Refetch (not just invalidate) so the avatar step's initials reflect the
      // new name immediately — useRealtimeSync isn't mounted outside the
      // authenticated shell, and a background refetch would render stale first.
      await queryClient.refetchQueries({ queryKey: orpc.user.me.key() })
      onNext()
    },
  })

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-1.5 text-center">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">
          {m.onboarding_name_title()}
        </h1>
        <p className="text-balance text-muted-foreground text-sm">
          {m.onboarding_name_description()}
        </p>
      </header>

      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          form.handleSubmit()
        }}
      >
        <FieldGroup>
          <form.AppField
            name="name"
            children={(field) => (
              <field.FloatingTextField
                label={m.onboarding_name_label()}
                autoComplete="name"
                autoFocus
              />
            )}
          />
        </FieldGroup>

        <form.AppForm>
          <form.SubmitButton label={m.onboarding_next()} size="xl" className="w-full font-normal" />
        </form.AppForm>
      </form>
    </div>
  )
}
