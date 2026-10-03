import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { integrationErrorMessage } from '~/lib/integrationHealthMessage'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type SyncSource = 'zaptec' | 'elpris' | 'skoda'
type SyncResult = {
  outcome: 'ok' | 'skipped' | 'failed' | 'error'
  code: IntegrationErrorCode | null
}

// The admin "sync now" mutations, shared by the heading button, each health
// alert's "Försök igen" and the empty session list's CTA. `syncAll` fires the
// session and price syncs in parallel, so the quick session sync isn't held
// behind a long price backfill; a retry runs only its own source. A run never
// throws for a failed/skipped outcome — those are ordinary — so each toast is
// chosen by `outcome`; `onError` covers only a transport/unexpected error,
// attributed to the source that raised it. Prices have two mutations so each
// call knows whether to announce: a full sync already toasts the session
// result (a price success stays silent), an explicit price retry confirms it.
// Every outcome can have changed health/runs/data, so the whole evCharging
// cache is invalidated.
export function useSyncNow() {
  const queryClient = useQueryClient()
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

  const pricesToast = (result: SyncResult, announce: boolean) => {
    switch (result.outcome) {
      case 'ok':
        if (announce) toast.success(m.charging_sync_prices_ok())
        return
      case 'skipped':
        if (announce) toast.info(m.charging_sync_skipped())
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
  }
  const pricesError = () =>
    toast.error(m.charging_sync_prices_failed(), {
      description: integrationErrorMessage('internal_error', { source: 'elpris' }),
    })
  // Part of a full sync: only a failure is worth a toast.
  const prices = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => pricesToast(result, false),
      onError: pricesError,
      onSettled: invalidate,
    }),
  )
  // An explicit price retry: confirm the outcome either way.
  const pricesRetry = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => pricesToast(result, true),
      onError: pricesError,
      onSettled: invalidate,
    }),
  )

  // The car's live state: an explicit admin action, so confirm either way.
  const car = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => {
        switch (result.outcome) {
          case 'ok':
            toast.success(m.charging_sync_skoda_ok())
            return
          case 'skipped':
            toast.info(m.charging_sync_skipped())
            return
          case 'failed':
          case 'error':
            toast.error(m.charging_sync_skoda_failed(), {
              description: integrationErrorMessage(result.code ?? 'internal_error', {
                source: 'skoda',
              }),
            })
            return
        }
      },
      onError: () =>
        toast.error(m.charging_sync_skoda_failed(), {
          description: integrationErrorMessage('internal_error', { source: 'skoda' }),
        }),
      onSettled: invalidate,
    }),
  )

  const pricesPending = prices.isPending || pricesRetry.isPending
  return {
    /** Both sources, in parallel. */
    syncAll: () => {
      sessions.mutate({ source: 'zaptec' })
      prices.mutate({ source: 'elpris' })
    },
    /** One source (an alert's retry). */
    syncSource: (source: SyncSource) => {
      switch (source) {
        case 'elpris':
          return pricesRetry.mutate({ source: 'elpris' })
        case 'skoda':
          return car.mutate({ source: 'skoda' })
        case 'zaptec':
          return sessions.mutate({ source: 'zaptec' })
      }
    },
    // The heading button syncs Zaptec + elpris only, never the car.
    isPending: sessions.isPending || pricesPending,
    isPendingFor: (source: SyncSource) => {
      switch (source) {
        case 'elpris':
          return pricesPending
        case 'skoda':
          return car.isPending
        case 'zaptec':
          return sessions.isPending
      }
    },
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
