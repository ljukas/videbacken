import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import type { CredentialOrigin } from '~/lib/integrationCredentials'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { CredentialsButton } from './CredentialsButton'

function statusText(origin: CredentialOrigin, unreadable: boolean) {
  if (unreadable) return m.charging_grid_status_unreadable()
  switch (origin) {
    case 'stored':
      return m.charging_grid_status_stored()
    case 'env':
      return m.charging_grid_status_env()
    case 'missing':
      return m.charging_grid_status_missing()
  }
}

// Where the grid facility ID comes from, with the key button into its dialog.
// Built like its sibling TariffCard. `facility` is undefined while the
// credential status is unknown: no status line then.
export function GridTariffCard({
  facility,
  unreadable,
  onOpenCredentials,
}: {
  facility: { origin: CredentialOrigin } | undefined
  unreadable: boolean
  onOpenCredentials: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.charging_grid_title()}</h2>
        </CardTitle>
        <CardDescription>{m.charging_grid_description()}</CardDescription>
        <CardAction>
          <CredentialsButton
            source="gridTariff"
            label={m.charging_grid_button()}
            onClick={onOpenCredentials}
          />
        </CardAction>
      </CardHeader>
      {/* The status and the cadence read as one group. */}
      <CardContent className="flex flex-col gap-1">
        {facility ? (
          <p className={cn('text-sm', unreadable && 'text-destructive')}>
            {statusText(facility.origin, unreadable)}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">{m.charging_grid_cadence()}</p>
      </CardContent>
    </Card>
  )
}
