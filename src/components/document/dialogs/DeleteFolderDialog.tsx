import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { orpc } from '~/lib/orpc/client'
import { folderErrorMessage } from '~/lib/orpc/folderErrorMessage'
import { optimisticRemove } from '~/lib/orpc/optimistic'
import { m } from '~/paraglide/messages'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  folder: { id: string; name: string }
}

export function DeleteFolderDialog({ open, onOpenChange, folder }: Props) {
  const queryClient = useQueryClient()

  const deleteMutation = useMutation(
    orpc.folder.softDeleteFolder.mutationOptions({
      // Drop the folder row from the tree before the round-trip. Its descendants
      // aren't in the current view, so removing the one row is the full visible
      // effect; the bin and document lists reconcile in onSettled.
      onMutate: ({ id }) =>
        optimisticRemove(queryClient, orpc.folder.tree.queryKey(), (f) => f.id === id),
      // onSuccess/onError/onSettled live on useMutation (not the mutate call) so
      // they still run after the instant close below. We keep the success toast
      // here because its cascade counts are genuinely informative — and it fires
      // even though the dialog has already closed.
      onSuccess: (result) =>
        toast.success(
          m.folder_deleted_toast({
            folders: result.foldersAffected,
            documents: result.documentsAffected,
          }),
        ),
      onError: (err) =>
        toast.error(isDefinedError(err) ? folderErrorMessage(err.code) : m.folder_delete_error()),
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.folder.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.document.listDocuments.key() }),
          // The folder and its documents land in the admin bin — refresh it.
          queryClient.invalidateQueries({ queryKey: orpc.bin.key() }),
        ]),
    }),
  )

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.document_delete_confirm_title({ name: folder.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>{m.folder_delete_description()}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteMutation.isPending}
          >
            {m.common_cancel()}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              // Optimistic instant-close: onMutate drops the row, we close now,
              // and onSuccess/onError/onSettled reconcile in the background.
              deleteMutation.mutate({ id: folder.id })
              onOpenChange(false)
            }}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
            {m.document_action_delete()}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
