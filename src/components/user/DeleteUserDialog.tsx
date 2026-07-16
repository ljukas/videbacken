import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Suspense } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Spinner } from '~/components/ui/spinner'
import { orpc } from '~/lib/orpc/client'
import { optimisticRemove } from '~/lib/orpc/optimistic'
import { userErrorMessage } from '~/lib/orpc/userErrorMessage'
import { m } from '~/paraglide/messages'

type Props = {
  open: boolean
  userId?: string
  onOpenChange: (open: boolean) => void
}

export function DeleteUserDialog({ open, userId, onOpenChange }: Props) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {userId ? (
          <Suspense fallback={<DeleteUserFallback />}>
            <DeleteUserBody key={userId} userId={userId} onDone={() => onOpenChange(false)} />
          </Suspense>
        ) : (
          <DeleteUserFallback />
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function DeleteUserFallback() {
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{m.user_delete_title()}</AlertDialogTitle>
        <AlertDialogDescription>{m.common_loading()}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
      </AlertDialogFooter>
    </>
  )
}

function DeleteUserBody({ userId, onDone }: { userId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { data: user } = useSuspenseQuery(orpc.user.getById.queryOptions({ input: { id: userId } }))

  const deleteMutation = useMutation(
    orpc.user.delete.mutationOptions({
      // Drop the row from the active owners list before the round-trip; the row
      // vanishing is the confirmation, so there's no success toast.
      onMutate: ({ id }) =>
        optimisticRemove(queryClient, orpc.user.listContacts.queryKey(), (u) => u.id === id),
      // onError/onSettled live on useMutation (not the mutate call) so they still
      // run after the instant close below. onSettled invalidates both user lists
      // (listContacts + list), reverting the optimistic removal on failure.
      onError: (err) => {
        toast.error(
          isDefinedError(err) ? userErrorMessage(err.code, 'delete') : m.user_delete_error(),
        )
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.user.key() }),
    }),
  )

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{m.user_delete_title()}</AlertDialogTitle>
        <AlertDialogDescription>
          {m.user_delete_confirm({ name: user.name })}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={deleteMutation.isPending}>
          {m.common_cancel()}
        </AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          disabled={deleteMutation.isPending}
          onClick={(e) => {
            e.preventDefault()
            // Optimistic instant-close: onMutate drops the row, we close now, and
            // onError/onSettled reconcile in the background. Delete has no
            // user-fixable failure, so nothing keeps the dialog open.
            deleteMutation.mutate({ id: userId })
            onDone()
          }}
        >
          {deleteMutation.isPending && <Spinner data-icon="inline-start" />}
          {m.common_delete()}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
