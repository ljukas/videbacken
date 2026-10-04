import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import type { IntegrationErrorCode } from '~/lib/integrationHealth'
import { integrationErrorMessage } from '~/lib/integrationHealthMessage'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type SyncSource = 'zaptec' | 'elpris' | 'skoda' | 'emaldo'
type SyncResult = {
  outcome: 'ok' | 'skipped' | 'failed' | 'error'
  code: IntegrationErrorCode | null
}

// The admin "sync now" mutations, shared by the heading button, each health
// alert's "Försök igen", each Datakällor tile's sync and the empty session
// list's CTA. `syncAll` fires the
// session, price and house-energy syncs in parallel, so the session toast isn't
// held behind a long price or house backfill; a retry runs only its own source. A run never throws for
// a failed/skipped outcome — those are ordinary — so each toast is chosen by
// `outcome`; `onError` covers only a transport/unexpected error,
// attributed to the source that raised it. Prices have two mutations so each
// call knows whether to announce: a full sync already toasts the session
// result (a price success stays silent), an explicit price retry confirms it.
// House energy, like prices, has two mutations: inside a full sync only a real
// failure toasts (an unconfigured Emaldo stays quiet, its Datakällor tile
// already says so); an explicit retry confirms either way.
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

  const houseToast = (result: SyncResult, announce: boolean) => {
    switch (result.outcome) {
      case 'ok':
        if (announce) toast.success(m.charging_sync_house_ok())
        return
      case 'skipped':
        if (announce) toast.info(m.charging_sync_skipped())
        return
      case 'failed':
      case 'error':
        // Unconfigured is a setup state, not news on every full sync.
        if (!announce && result.code === 'not_configured') return
        toast.error(m.charging_sync_house_failed(), {
          description: integrationErrorMessage(result.code ?? 'internal_error', {
            source: 'emaldo',
          }),
        })
        return
    }
  }
  const houseError = () =>
    toast.error(m.charging_sync_house_failed(), {
      description: integrationErrorMessage('internal_error', { source: 'emaldo' }),
    })
  // Part of a full sync: only a failure is worth a toast.
  const house = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => houseToast(result, false),
      onError: houseError,
      onSettled: invalidate,
    }),
  )
  // An explicit retry: confirm the outcome either way.
  const houseRetry = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => houseToast(result, true),
      onError: houseError,
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
  const housePending = house.isPending || houseRetry.isPending
  return {
    /** Sessions, prices and house energy, in parallel. */
    syncAll: () => {
      sessions.mutate({ source: 'zaptec' })
      prices.mutate({ source: 'elpris' })
      house.mutate({ source: 'emaldo' })
    },
    /** One source (an alert's retry, or a Datakällor tile's sync). */
    syncSource: (source: SyncSource) => {
      switch (source) {
        case 'elpris':
          return pricesRetry.mutate({ source: 'elpris' })
        case 'skoda':
          return car.mutate({ source: 'skoda' })
        case 'emaldo':
          return houseRetry.mutate({ source: 'emaldo' })
        case 'zaptec':
          return sessions.mutate({ source: 'zaptec' })
      }
    },
    // The heading button syncs everything but the car, but waits only on
    // sessions and prices: a house run can take minutes while the backfill
    // runs, and its Datakällor tile shows its own "Synkar…". A second click while
    // it runs is skipped by the integration lease.
    isPending: sessions.isPending || pricesPending,
    isPendingFor: (source: SyncSource) => {
      switch (source) {
        case 'elpris':
          return pricesPending
        case 'skoda':
          return car.isPending
        case 'emaldo':
          return housePending
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
  'aria-label': ariaLabel,
  keepFocusWhilePending = false,
}: {
  onSync: () => void
  pending: boolean
  label?: string
  variant?: 'outline' | 'default'
  /** Names the button when several sit on one screen ("Synka nu, Zaptec": the visible label first, WCAG 2.5.3). */
  'aria-label'?: string
  /**
   * While pending, mark the button aria-disabled (and ignore clicks) instead of
   * `disabled`, so a keyboard user who just pressed it keeps focus there rather
   * than being dropped to <body> — for screens with several of these side by side.
   */
  keepFocusWhilePending?: boolean
}) {
  const softDisabled = keepFocusWhilePending && pending
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={softDisabled ? undefined : onSync}
      disabled={pending && !keepFocusWhilePending}
      aria-disabled={softDisabled || undefined}
      aria-label={ariaLabel}
      className={cn(softDisabled && 'cursor-not-allowed opacity-50')}
    >
      <RefreshCwIcon className={cn(pending && 'animate-spin motion-reduce:animate-none')} />
      {label}
    </Button>
  )
}
