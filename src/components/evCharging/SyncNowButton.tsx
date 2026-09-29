import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { integrationErrorMessage } from '~/lib/integrationHealthMessage'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

// The admin "sync now" mutation, shared by the heading button, the health
// alerts' "Försök igen" and the empty session list's CTA. It runs both syncs
// (sessions and spot prices). Neither throws for a failed/skipped run — those
// are ordinary outcomes — so the toasts are chosen by `outcome`: the session
// sync's as before, plus an extra error toast when the price sync failed (a
// price failure must never hide behind a green "N sessions updated").
// `onError` only covers a transport/unexpected error. Every outcome can have
// changed health/runs/data, so the whole evCharging cache is invalidated.
export function useSyncNow() {
  const queryClient = useQueryClient()
  const mutation = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => {
        switch (result.outcome) {
          case 'ok':
            toast.success(m.charging_sync_ok({ count: result.upserted }))
            break
          case 'skipped':
            toast.info(m.charging_sync_skipped())
            break
          case 'failed':
          case 'error':
            toast.error(m.charging_sync_failed(), {
              description: integrationErrorMessage(result.code ?? 'internal_error', {
                source: 'zaptec',
              }),
            })
            break
        }
        if (result.elpris.outcome === 'failed' || result.elpris.outcome === 'error') {
          toast.error(m.charging_sync_prices_failed(), {
            description: integrationErrorMessage(result.elpris.code ?? 'internal_error', {
              source: 'elpris',
            }),
          })
        }
      },
      onError: () => {
        toast.error(m.charging_sync_failed(), {
          description: integrationErrorMessage('internal_error', { source: 'zaptec' }),
        })
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() }),
    }),
  )
  return { sync: () => mutation.mutate(undefined), isPending: mutation.isPending }
}

export function SyncNowButton({
  onSync,
  pending,
  label = m.charging_sync_now(),
  variant = 'outline',
}: {
  onSync: () => void
  pending: boolean
  label?: string
  variant?: 'outline' | 'default'
}) {
  return (
    <Button variant={variant} size="sm" onClick={onSync} disabled={pending}>
      <RefreshCwIcon className={cn(pending && 'animate-spin motion-reduce:animate-none')} />
      {label}
    </Button>
  )
}
