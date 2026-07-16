import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Suspense } from 'react'
import { toast } from 'sonner'
import { Field, FieldDescription, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { Spinner } from '~/components/ui/spinner'
import {
  type UserFieldsValues,
  UserFormFields,
  userFieldsMap,
  userFieldsSchema,
} from '~/components/user/UserFormFields'
import { useAppForm } from '~/hooks/form'
import { orpc } from '~/lib/orpc/client'
import { optimisticPatch } from '~/lib/orpc/optimistic'
import { userErrorMessage } from '~/lib/orpc/userErrorMessage'
import { m } from '~/paraglide/messages'

type Props = {
  open: boolean
  userId?: string
  onOpenChange: (open: boolean) => void
}

export function EditUserDialog({ open, userId, onOpenChange }: Props) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{m.user_edit_title()}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{m.user_edit_description()}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {userId ? (
          <Suspense
            fallback={
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            }
          >
            <EditUserDialogBody key={userId} userId={userId} onDone={() => onOpenChange(false)} />
          </Suspense>
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function EditUserDialogBody({ userId, onDone }: { userId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  // Edit only ever targets an *active* row, already present in the `user.list`
  // cache the route loader ensured — no separate detail fetch needed (unlike
  // the old model, reads are the same list everyone already has).
  const { data: users } = useSuspenseQuery(orpc.user.list.queryOptions())
  const target = users.find((u) => u.id === userId)

  const updateMutation = useMutation(
    orpc.user.updateAsAdmin.mutationOptions({
      // Paint the edited fields into the active list before the round-trip;
      // the updated row is the confirmation, so there's no success toast.
      onMutate: (vars) =>
        optimisticPatch(
          queryClient,
          orpc.user.list.queryKey(),
          (u) => u.id === userId,
          (u) => ({
            ...u,
            name: vars.name,
            phone: vars.phone,
            role: vars.role,
          }),
        ),
      // onError/onSettled live on useMutation (not the mutate call) so they still
      // run after the instant close below. onSettled re-syncs every user query,
      // reverting the optimistic patch on failure.
      onError: (err) => {
        toast.error(
          isDefinedError(err) ? userErrorMessage(err.code, 'demote') : m.user_update_error(),
        )
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.user.key() }),
    }),
  )

  const defaultValues: UserFieldsValues = {
    name: target?.name ?? '',
    phone: target?.phone ?? '',
    role: target?.role === 'admin' ? 'admin' : 'user',
  }

  const form = useAppForm({
    defaultValues,
    validators: { onSubmit: userFieldsSchema },
    onSubmit: ({ value }) => {
      // Optimistic instant-close: onMutate patches the row, we close now, and
      // onError/onSettled reconcile in the background. No user-fixable failure
      // (LAST_ADMIN / CANNOT_ACT_ON_SELF aren't fixable here — they only toast).
      updateMutation.mutate({ id: userId, ...value })
      onDone()
    },
  })

  if (!target) return null

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        {/* Email is the sign-in identity, so it's immutable after invite —
            shown read-only for context. Change of address = revoke + re-invite. */}
        <Field>
          <FieldLabel htmlFor="edit-user-email">{m.user_field_email()}</FieldLabel>
          <Input id="edit-user-email" type="email" value={target.email} disabled readOnly />
          <FieldDescription>{m.user_field_email_locked_hint()}</FieldDescription>
        </Field>
        <UserFormFields form={form} fields={userFieldsMap} />
      </div>

      <ResponsiveDialogFooter className="mt-6">
        <form.AppForm>
          <form.CancelButton onClick={onDone}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton label={m.common_save()} />
        </form.AppForm>
      </ResponsiveDialogFooter>
    </form>
  )
}
