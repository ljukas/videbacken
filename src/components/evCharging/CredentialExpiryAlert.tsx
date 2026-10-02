import { KeyRoundIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatDate } from './format'

type Expiry = NonNullable<
  RouterOutputs['evCharging']['syncStatus']['adminDetail']
>['credentialExpiry']

// Admin-only (the caller passes adminDetail, which only admins get): the Škoda
// key expires about every six months (ADR-0022). The server decides when to
// warn; once expired the health alert (auth_failed) takes over, so nothing here.
export function CredentialExpiryAlert({ expiry }: { expiry: Expiry }) {
  if (!expiry?.warn || expiry.daysLeft <= 0) return null
  return (
    <Alert role="status" variant={expiry.daysLeft <= 7 ? 'destructive' : 'default'}>
      <KeyRoundIcon />
      <AlertTitle>{m.charging_skoda_key_expiring_title()}</AlertTitle>
      <AlertDescription>
        {m.charging_skoda_key_expiring_body({
          date: formatDate(expiry.expiresAt),
          days: expiry.daysLeft,
        })}
      </AlertDescription>
    </Alert>
  )
}
