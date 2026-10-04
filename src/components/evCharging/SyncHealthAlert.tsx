import { AlertTriangleIcon, InfoIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import {
  integrationErrorMessage,
  integrationHealthTitle,
  integrationSourceName,
} from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatDateTime } from './format'
import { SyncNowButton } from './SyncNowButton'

type Health = RouterOutputs['evCharging']['syncStatus']

// Sync health banner, driven by `state` alone (never re-derived from the
// timestamps client-side — the server owns the stale/failing policy). `ok`
// renders nothing. Admins additionally see the raw (sanitized) last error and
// a retry that re-runs only this alert's source (`useSyncNow().syncSource`).
export function SyncHealthAlert({
  health,
  isAdmin,
  onRetry,
  retrying,
}: {
  health: Health
  isAdmin: boolean
  onRetry: () => void
  retrying: boolean
}) {
  const title = m.charging_health_title({
    source: integrationSourceName(health.source),
    state: integrationHealthTitle(health.state),
  })

  switch (health.state) {
    case 'ok':
      return null
    case 'never_synced':
      return (
        <HealthAlert variant="default" title={title}>
          <div>{neverSyncedCopy(health.source)}</div>
          {isAdmin ? <RetryRow onRetry={onRetry} retrying={retrying} /> : null}
        </HealthAlert>
      )
    case 'not_configured':
      // Retrying can't fix missing credentials, so no retry here.
      return (
        <HealthAlert variant="default" title={title}>
          <div>{integrationErrorMessage('not_configured', { source: health.source })}</div>
        </HealthAlert>
      )
    case 'stale':
      return (
        <HealthAlert variant="default" title={title}>
          <div>{staleCopy(health.source)}</div>
          {isAdmin ? <AdminDetail health={health} onRetry={onRetry} retrying={retrying} /> : null}
        </HealthAlert>
      )
    case 'failing':
      return (
        <HealthAlert variant="destructive" title={title}>
          <div>
            {integrationErrorMessage(health.code ?? 'internal_error', { source: health.source })}
            {health.failingSince ? (
              <> {m.charging_health_failing_since({ time: formatDateTime(health.failingSince) })}</>
            ) : null}
          </div>
          {isAdmin ? <AdminDetail health={health} onRetry={onRetry} retrying={retrying} /> : null}
        </HealthAlert>
      )
  }
}

// The state bodies that differ by source: sessions sync hourly and feed the
// totals; prices sync daily and feed costs; the car's state polls every 15 min
// and feeds attribution; the house's energy flows sync hourly and will feed the
// cost mix. Exhaustive — a new source is a
// compile error until it gets its own copy.
function neverSyncedCopy(source: Health['source']): string {
  switch (source) {
    case 'zaptec':
      return m.charging_health_never_synced()
    case 'elpris':
      return m.charging_health_never_synced_elpris()
    case 'skoda':
      return m.charging_health_never_synced_skoda()
    case 'emaldo':
      return m.charging_health_never_synced_emaldo()
  }
}

function staleCopy(source: Health['source']): string {
  switch (source) {
    case 'zaptec':
      return m.charging_health_stale()
    case 'elpris':
      return m.charging_health_stale_elpris()
    case 'skoda':
      return m.charging_health_stale_skoda()
    case 'emaldo':
      return m.charging_health_stale_emaldo()
  }
}

function HealthAlert({
  variant,
  title,
  children,
}: {
  variant: 'default' | 'destructive'
  title: string
  children: React.ReactNode
}) {
  // Only a failure interrupts (role=alert); informational states are a polite
  // status, so two alerts refetching together don't shout over each other.
  return (
    <Alert variant={variant} role={variant === 'destructive' ? 'alert' : 'status'}>
      {variant === 'destructive' ? <AlertTriangleIcon /> : <InfoIcon />}
      <AlertTitle>{title}</AlertTitle>
      {/* Children are divs, not <p>: AlertDescription adds a large bottom margin between paragraphs. */}
      <AlertDescription className="flex flex-col gap-2">{children}</AlertDescription>
    </Alert>
  )
}

function AdminDetail({
  health,
  onRetry,
  retrying,
}: {
  health: Health
  onRetry: () => void
  retrying: boolean
}) {
  const message = health.adminDetail?.lastErrorMessage
  return (
    <>
      {message ? (
        <div className="text-muted-foreground">
          {m.charging_health_admin_detail()}{' '}
          <code className="break-all font-mono text-xs">{message}</code>
        </div>
      ) : null}
      <RetryRow onRetry={onRetry} retrying={retrying} />
    </>
  )
}

function RetryRow({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div>
      <SyncNowButton onSync={onRetry} pending={retrying} label={m.common_try_again()} />
    </div>
  )
}
