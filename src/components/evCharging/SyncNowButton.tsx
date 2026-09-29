import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { integrationErrorMessage } from '~/lib/integrationHealthMessage'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type SyncSource = 'zaptec' | 'elpris'

// The admin "sync now" mutations, shared by the heading button, each health
// alert's "Försök igen" and the empty session list's CTA. One mutation per
// source: `syncAll` fires both in parallel, so the quick session sync isn't
// held behind a long price backfill, and a retry runs only its own source.
// A run never throws for a failed/skipped outcome — those are ordinary — so
// each source's toast is chosen by its `outcome`; `onError` covers only a
// transport/unexpected error, attributed to the source that raised it. A
// successful price sync is only announced when prices were synced on their
// own (a full sync already toasts the session result). Every outcome can have
// changed health/runs/data, so the whole evCharging cache is invalidated.
export function useSyncNow() {
  const queryClient = useQueryClient()
  const announcePricesOk = useRef(false)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() })

  const sessions = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => {
        switch (result.outcome) {
          case 'ok':
            toast.success(m.charging_sync_ok({ count: result.upserted }))
            return
          case 'skipped':
            toast.info(m.charging_sync_skipped())
            return
          case 'failed':
          case 'error':
            toast.error(m.charging_sync_failed(), {
              description: integrationErrorMessage(result.code ?? 'internal_error', {
                source: 'zaptec',
              }),
            })
            return
        }
      },
      onError: () => {
        toast.error(m.charging_sync_failed(), {
          description: integrationErrorMessage('internal_error', { source: 'zaptec' }),
        })
      },
      onSettled: invalidate,
    }),
  )

  const prices = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => {
        switch (result.outcome) {
          case 'ok':
            if (announcePricesOk.current) toast.success(m.charging_sync_prices_ok())
            return
          case 'skipped':
            if (announcePricesOk.current) toast.info(m.charging_sync_skipped())
            return
          case 'failed':
          case 'error':
            toast.error(m.charging_sync_prices_failed(), {
              description: integrationErrorMessage(result.code ?? 'internal_error', {
                source: 'elpris',
              }),
            })
            return
        }
      },
      onError: () => {
        toast.error(m.charging_sync_prices_failed(), {
          description: integrationErrorMessage('internal_error', { source: 'elpris' }),
        })
      },
      onSettled: invalidate,
    }),
  )

  const mutationFor = (source: SyncSource) => (source === 'elpris' ? prices : sessions)
  return {
    /** Both sources, in parallel. */
    syncAll: () => {
      announcePricesOk.current = false
      sessions.mutate({ source: 'zaptec' })
      prices.mutate({ source: 'elpris' })
    },
    /** One source (an alert's retry). */
    syncSource: (source: SyncSource) => {
      if (source === 'elpris') announcePricesOk.current = true
      mutationFor(source).mutate({ source })
    },
    isPending: sessions.isPending || prices.isPending,
    isPendingFor: (source: SyncSource) => mutationFor(source).isPending,
  }
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
