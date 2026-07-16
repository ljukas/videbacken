import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
  userName?: string
  onOpenChange: (open: boolean) => void
}

export function RestoreUserDialog({ open, userId, userName, onOpenChange }: Props) {
  const queryClient = useQueryClient()

  const restoreMutation = useMutation(
    orpc.user.restore.mutationOptions({
      // Drop the row from the deleted owners list before the round-trip; the row
      // vanishing is the confirmation, so there's no success toast.
      onMutate: ({ id }) =>
        optimisticRemove(
          queryClient,
          orpc.user.list.queryKey({ input: { filter: 'deleted' } }),
          (u) => u.id === id,
        ),
      // onError/onSettled live on useMutation (not the mutate call) so they still
      // run after the instant close below. onSettled re-syncs every user query so
      // the restored user reappears in the active list (and reverts on failure).
      onError: (err) => {
        toast.error(isDefinedError(err) ? userErrorMessage(err.code) : m.user_restore_error())
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.user.key() }),
    }),
  )

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.user_restore_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {userName ? m.user_restore_confirm_named({ name: userName }) : m.user_restore_confirm()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={restoreMutation.isPending}>
            {m.common_cancel()}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={restoreMutation.isPending || !userId}
            onClick={(e) => {
              e.preventDefault()
              if (!userId) return
              // Optimistic instant-close: onMutate drops the row, we close now,
              // and onError/onSettled reconcile in the background.
              restoreMutation.mutate({ id: userId })
              onOpenChange(false)
            }}
          >
            {restoreMutation.isPending && <Spinner data-icon="inline-start" />}
            {m.common_restore()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
