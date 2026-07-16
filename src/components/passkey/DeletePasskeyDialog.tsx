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
import { useDeletePasskey } from '~/hooks/usePasskeys'
import { m } from '~/paraglide/messages'

type Props = {
  passkeyId: string | null
  onClose: () => void
}

export function DeletePasskeyDialog({ passkeyId, onClose }: Props) {
  const deletePasskey = useDeletePasskey()

  return (
    <AlertDialog
      open={passkeyId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.passkey_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.passkey_delete_description()}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletePasskey.isPending}>
            {m.common_cancel()}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deletePasskey.isPending || !passkeyId}
            onClick={(e) => {
              e.preventDefault()
              if (!passkeyId) return
              deletePasskey.mutate(passkeyId, { onSuccess: onClose })
            }}
          >
            {deletePasskey.isPending && <Spinner data-icon="inline-start" />}
            {m.common_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
