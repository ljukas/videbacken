import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import type { UserOption } from '~/components/form/UserSelectField'
import { useAppForm } from '~/hooks/form'
import { orpc } from '~/lib/orpc/client'
import { optimisticPatch } from '~/lib/orpc/optimistic'
import type { AdminShareRow } from '~/lib/orpc/procedures/share'
import { m } from '~/paraglide/messages'

// The share-assignment form: one owner + effective date (shares are
// indivisible per ADR-0018). Lives on a dedicated route rather than an
// overlay — see ADR-0013. Container-agnostic: the route supplies the data +
// page chrome and an `onDone` (navigate back to the grid), called after the
// optimistic submit and on cancel.

function todayUtc(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}

const schema = z.object({
  from: z.date(),
  userId: z.string().min(1, { error: () => m.share_validation_owner_required() }),
})

type Props = {
  share: AdminShareRow
  users: ReadonlyArray<UserOption>
  /** Navigate back to the grid — called after an optimistic submit and on cancel. */
  onDone: () => void
}

export function ShareAssignForm({ share, users, onDone }: Props) {
  const queryClient = useQueryClient()

  // Build the optimistic owner cell from the selected option. UserOption carries
  // no blurhash, so leave it null — the onSettled refetch fills in the real one.
  const ownerFromOption = (userId: string): AdminShareRow['currentOwner'] => {
    const u = users.find((o) => o.id === userId)
    return u ? { id: u.id, name: u.name, image: u.image, imageBlurhash: null } : null
  }

  const assignMutation = useMutation(
    orpc.share.assign.mutationOptions({
      // Paint the new owner into the admin grid before the round-trip. "Current
      // owner" in listAll is the open-ended assignment's owner, so it flips to the
      // new owner regardless of the effective `from` date — this patch is always
      // correct. The owners list (listContacts share badges) reconciles on settle.
      onMutate: (vars) =>
        optimisticPatch(
          queryClient,
          orpc.share.listAll.queryKey(),
          (s) => s.shareCode === vars.shareCode,
          (s) => ({ ...s, currentOwner: ownerFromOption(vars.userId) }),
        ),
      // onError/onSettled live on useMutation (not the mutate call) so they still
      // run after we navigate away below. onSettled re-syncs the grid and owners
      // to the backend's truth (and reverts the optimistic patch on failure).
      onError: (err) => {
        toast.error(err.message || m.share_assign_error())
      },
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.share.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.user.listContacts.key() }),
        ]),
    }),
  )

  const form = useAppForm({
    defaultValues: {
      from: todayUtc(),
      userId: share.currentOwner?.id ?? '',
    },
    validators: { onSubmit: schema },
    onSubmit: ({ value }) => {
      // Optimistic submit: onMutate paints the new owner, we navigate back now,
      // and onError/onSettled reconcile in the background.
      assignMutation.mutate({
        shareCode: share.shareCode,
        from: value.from,
        userId: value.userId,
      })
      onDone()
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
      className="flex flex-col gap-4"
    >
      <form.AppField
        name="from"
        children={(field) => <field.DateField label={m.share_field_from()} />}
      />
      <form.AppField
        name="userId"
        children={(field) => (
          <field.UserSelectField label={m.share_field_new_owner()} users={users} />
        )}
      />

      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <form.AppForm>
          <form.CancelButton onClick={onDone}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton
            label={m.share_assign_submit()}
            pendingLabel={m.share_assign_pending()}
          />
        </form.AppForm>
      </div>
    </form>
  )
}
