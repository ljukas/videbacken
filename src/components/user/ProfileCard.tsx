import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { LockIcon } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Field, FieldTitle } from '~/components/ui/field'
import { AvatarUpload } from '~/components/user/AvatarUpload'
import { useAppForm } from '~/hooks/form'
import { logger } from '~/lib/logger/browser'
import { orpc } from '~/lib/orpc/client'
import { nameField, phoneField } from '~/lib/orpc/userProfileSchema'
import { m } from '~/paraglide/messages'

// name + phone reuse the shared validators (see ~/lib/orpc/userProfileSchema) so
// this self-service card can't validate differently from the `user.updateProfile`
// procedure that saves it. No `role` (a user can't change their own role) and no
// editable `email` (immutable login identity — shown read-only below; ADR-0017).
const profileSchema = z.object({ name: nameField, phone: phoneField })

// Linear-style settings rows: each Field stacks on a narrow card and goes
// label-left at the @md container breakpoint (see ADR-0015 account amendment).
// p-4 = the divided row padding. CONTROL_WIDTH pins the editable control to a
// fixed width on the right at @md (the `responsive` variant otherwise lets the
// control size to content — fine for text, collapses the phone control).
const ROW = 'p-4'
const CONTROL_WIDTH = 'w-full @md/field-group:w-64'

export function ProfileCard() {
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())
  const queryClient = useQueryClient()
  const updateMutation = useMutation(orpc.user.updateProfile.mutationOptions())

  const form = useAppForm({
    defaultValues: { name: me.name, phone: me.phone ?? '' },
    validators: { onSubmit: profileSchema },
    onSubmit: async ({ value }) => {
      try {
        await updateMutation.mutateAsync(value)
      } catch (error) {
        logger.warn('profile save failed', { error })
        toast.error(m.user_update_error())
        return
      }
      // Name/phone surface in the contact list and the avatar initials. Refetch
      // `me` (not just invalidate) so this tab reflects the change immediately —
      // useRealtimeSync ignores events from its own source — and invalidate the
      // owner lists so they're fresh on next visit (mirrors AvatarUpload).
      await queryClient.refetchQueries({ queryKey: orpc.user.me.key() })
      queryClient.invalidateQueries({ queryKey: orpc.user.list.key() })
      queryClient.invalidateQueries({ queryKey: orpc.user.listContacts.key() })
      toast.success(m.account_profile_saved())
    },
  })

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="@container/field-group divide-y rounded-lg border bg-surface-raised">
        {/* Profile picture — uploads immediately on its own (independent of Save).
            FieldTitle (a label-styled div, not a <label>) since the control is a
            button with its own aria-label — avoids an orphaned label. */}
        <Field orientation="responsive" className={ROW}>
          <FieldTitle>{m.account_avatar_heading()}</FieldTitle>
          <AvatarUpload variant="row" />
        </Field>

        {/* Email — the magic-link login identity, immutable after invite (ADR-0017).
            Display-only row → FieldTitle, no <label> (there's no input to bind). */}
        <Field orientation="responsive" className={ROW}>
          <FieldTitle>{m.user_field_email()}</FieldTitle>
          <span className="flex items-center gap-2 text-muted-foreground text-sm">
            <span className="break-all">{me.email}</span>
            <LockIcon
              role="img"
              aria-label={m.account_email_locked_hint()}
              className="size-3.5 shrink-0"
            />
          </span>
        </Field>

        <form.AppField
          name="name"
          children={(field) => (
            <field.TextField
              label={m.user_field_name()}
              autoComplete="name"
              orientation="responsive"
              fieldClassName={ROW}
              inputClassName={CONTROL_WIDTH}
            />
          )}
        />

        <form.AppField
          name="phone"
          children={(field) => (
            <field.PhoneField
              label={m.user_field_phone()}
              orientation="responsive"
              fieldClassName={ROW}
              controlClassName={CONTROL_WIDTH}
            />
          )}
        />
      </div>

      <form.AppForm>
        <form.SubmitButton label={m.common_save()} className="self-end" />
      </form.AppForm>
    </form>
  )
}
