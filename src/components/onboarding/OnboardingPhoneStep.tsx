import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { ArrowLeftIcon } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '~/components/ui/button'
import { FieldGroup } from '~/components/ui/field'
import { useAppForm } from '~/hooks/form'
import { logger } from '~/lib/logger/browser'
import { orpc } from '~/lib/orpc/client'
import { phoneField } from '~/lib/orpc/userProfileSchema'
import { m } from '~/paraglide/messages'

// Single-field form schema; the phone rules live in the shared validator so the
// client and the `user.updateProfile` procedure can't diverge.
const phoneSchema = z.object({ phone: phoneField })

type Props = {
  onNext: () => void
  onSkip: () => void
  onBack: () => void
}

export function OnboardingPhoneStep({ onNext, onSkip, onBack }: Props) {
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())
  const queryClient = useQueryClient()
  const updateMutation = useMutation(orpc.user.updateProfile.mutationOptions())

  const form = useAppForm({
    defaultValues: { phone: me.phone ?? '' },
    validators: { onSubmit: phoneSchema },
    onSubmit: async ({ value }) => {
      try {
        await updateMutation.mutateAsync({ phone: value.phone })
      } catch (error) {
        logger.warn('onboarding phone save failed', { error })
        toast.error(m.onboarding_save_error())
        return
      }
      // Refetch (not just invalidate) so a Back from the avatar step remounts
      // this step with the just-saved number — the form re-reads `me.phone`
      // from cache as its default; a stale cache would show it blank.
      await queryClient.refetchQueries({ queryKey: orpc.user.me.key() })
      onNext()
    },
  })

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-1.5 text-center">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">
          {m.onboarding_phone_title()}
        </h1>
        <p className="text-balance text-muted-foreground text-sm">
          {m.onboarding_phone_description()}
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
            name="phone"
            children={(field) => (
              <field.FloatingPhoneField label={m.onboarding_phone_label()} autoFocus />
            )}
          />
        </FieldGroup>

        <form.AppForm>
          <form.SubmitButton label={m.onboarding_next()} size="xl" className="w-full font-normal" />
        </form.AppForm>
      </form>

      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          {m.common_back()}
        </Button>
        <Button type="button" variant="ghost" onClick={onSkip}>
          {m.onboarding_skip()}
        </Button>
      </div>
    </div>
  )
}
