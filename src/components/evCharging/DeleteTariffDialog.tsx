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
import { tariffErrorMessage } from '~/lib/orpc/tariffErrorMessage'
import { m } from '~/paraglide/messages'
import { formatDay } from './format'
import type { Tariff } from './TariffDialog'

type Props = {
  open: boolean
  tariff: Tariff | undefined
  onOpenChange: (open: boolean) => void
}

// Confirm before deleting a tariff period: it re-prices every day it covered
// (with the previous period, or no cost at all).
export function DeleteTariffDialog({ open, tariff, onOpenChange }: Props) {
  const queryClient = useQueryClient()
  const remove = useMutation(
    orpc.tariff.remove.mutationOptions({
      onSuccess: () => toast.success(m.charging_tariff_deleted()),
      onError: (err) =>
        toast.error(
          isDefinedError(err) ? tariffErrorMessage(err.code) : m.charging_tariff_delete_error(),
        ),
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.tariff.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() }),
        ]),
    }),
  )

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {tariff ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.charging_tariff_delete_title()}</AlertDialogTitle>
              <AlertDialogDescription>
                {m.charging_tariff_delete_confirm({ date: formatDay(tariff.validFrom) })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>{m.common_cancel()}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={remove.isPending}
                onClick={(e) => {
                  e.preventDefault()
                  // Instant close; the toast and invalidation reconcile after.
                  remove.mutate({ id: tariff.id })
                  onOpenChange(false)
                }}
              >
                {remove.isPending && <Spinner data-icon="inline-start" />}
                {m.charging_tariff_delete_action()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}
