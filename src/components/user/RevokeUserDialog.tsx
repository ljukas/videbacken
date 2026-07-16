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

export type RevokeTarget = {
  email: string
  name: string | null
  status: 'active' | 'pending'
}

type Props = {
  open: boolean
  target?: RevokeTarget
  onOpenChange: (open: boolean) => void
}

/**
 * Revoke access — replaces the old delete/restore pair (ADR-0017 amendment).
 * Targets by `email`, not id: it works uniformly for a still-pending invite
 * (just an `approved_email` row, no user id yet) and an active user (whose row
 * also gets soft-deleted + sessions revoked server-side).
 */
export function RevokeUserDialog({ open, target, onOpenChange }: Props) {
  const queryClient = useQueryClient()

  const revokeMutation = useMutation(
    orpc.user.revoke.mutationOptions({
      // Drop the row from the active list before the round-trip; the row
      // vanishing is the confirmation, so there's no success toast.
      onMutate: ({ email }) =>
        optimisticRemove(queryClient, orpc.user.list.queryKey(), (u) => u.email === email),
      // onError/onSettled live on useMutation (not the mutate call) so they still
      // run after the instant close below. onSettled invalidates the user list,
      // reverting the optimistic removal on failure.
      onError: (err) => {
        toast.error(
          isDefinedError(err) ? userErrorMessage(err.code, 'revoke') : m.user_revoke_error(),
        )
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.user.key() }),
    }),
  )

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {target ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.user_revoke_title()}</AlertDialogTitle>
              <AlertDialogDescription>
                {target.status === 'pending'
                  ? m.user_revoke_confirm_pending({ email: target.email })
                  : m.user_revoke_confirm_active({ name: target.name || target.email })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={revokeMutation.isPending}>
                {m.common_cancel()}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={revokeMutation.isPending}
                onClick={(e) => {
                  e.preventDefault()
                  // Optimistic instant-close: onMutate drops the row, we close
                  // now, and onError/onSettled reconcile in the background.
                  revokeMutation.mutate({ email: target.email })
                  onOpenChange(false)
                }}
              >
                {revokeMutation.isPending && <Spinner data-icon="inline-start" />}
                {m.user_revoke_action()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}
