import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FieldGroup } from '~/components/ui/field'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { roleOptions } from '~/components/user/UserFormFields'
import { useAppForm } from '~/hooks/form'
import { orpc } from '~/lib/orpc/client'
import { userErrorMessage } from '~/lib/orpc/userErrorMessage'
// `{ email, role }` — name, phone and avatar are collected later in
// onboarding once the invitee actually signs in. Shared with the procedure's
// `.input(...)` so client and server validate identically.
import { inviteInputSchema } from '~/lib/orpc/userInviteSchema'
import { m } from '~/paraglide/messages'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InviteUserDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient()

  const inviteMutation = useMutation(
    // Invalidate + toasts live here (typed `err`) so they survive the dialog unmount.
    orpc.user.invite.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.user.key() })
        toast.success(m.user_invite_sent())
      },
      onError: (err) => {
        toast.error(isDefinedError(err) ? userErrorMessage(err.code) : m.user_invite_error())
      },
    }),
  )

  const form = useAppForm({
    defaultValues: { email: '', role: 'user' as 'user' | 'admin' },
    validators: { onSubmit: inviteInputSchema },
    // Pessimistic close: EMAIL_ALREADY_APPROVED is user-fixable (ADR-0013), so
    // only reset + close once the invite lands; on failure onError toasts and
    // the dialog stays open so the admin can fix the address.
    onSubmit: ({ value, formApi }) => {
      inviteMutation.mutate(value, {
        onSuccess: () => {
          formApi.reset()
          onOpenChange(false)
        },
      })
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{m.user_invite_title()}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{m.user_invite_description()}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.AppField
              name="email"
              children={(field) => (
                <field.TextField label={m.user_field_email()} type="email" autoComplete="email" />
              )}
            />
            <form.AppField
              name="role"
              children={(field) => (
                <field.ToggleField label={m.user_field_role()} options={roleOptions()} />
              )}
            />
          </FieldGroup>

          <ResponsiveDialogFooter className="mt-6">
            <form.AppForm>
              <form.CancelButton onClick={() => onOpenChange(false)}>
                {m.common_cancel()}
              </form.CancelButton>
              <form.SubmitButton label={m.user_invite_submit()} />
            </form.AppForm>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
