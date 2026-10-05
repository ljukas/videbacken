import { KeyRoundIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { m } from '~/paraglide/messages'
import { formatDate } from './format'
import { SettingsLink } from './SettingsLink'
import type { SourceHealth } from './syncHealth'

type Expiry = NonNullable<SourceHealth['adminDetail']>['credentialExpiry']

// Admin-only (the caller passes adminDetail, which only admins get): the Škoda
// key expires about every six months (ADR-0022). The server decides when to
// warn; once expired the health alert (auth_failed) takes over, so nothing here.
// On the expiry day itself (0 calendar days left, not yet expired) it says today.
export function CredentialExpiryAlert({
  expiry,
  settingsLink = false,
}: {
  expiry: Expiry
  /** A link to the settings page, where the Škoda source lives. */
  settingsLink?: boolean
}) {
  if (!expiry?.warn || expiry.expired) return null
  // Same split as SyncHealthAlert: only the urgent state interrupts (role=alert).
  const urgent = expiry.daysLeft <= 7
  return (
    <Alert role={urgent ? 'alert' : 'status'} variant={urgent ? 'destructive' : 'default'}>
      <KeyRoundIcon />
      <AlertTitle>{m.charging_skoda_key_expiring_title()}</AlertTitle>
      {/* Children are divs, not <p>: AlertDescription adds a large bottom margin between paragraphs. */}
      <AlertDescription className="flex flex-col gap-2">
        <div>
          {expiry.daysLeft === 0
            ? m.charging_skoda_key_expiring_body_today({ date: formatDate(expiry.expiresAt) })
            : m.charging_skoda_key_expiring_body({
                date: formatDate(expiry.expiresAt),
                days: expiry.daysLeft,
              })}
        </div>
        {settingsLink ? (
          <div>
            <SettingsLink />
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
