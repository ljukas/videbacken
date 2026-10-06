import { Card } from '~/components/ui/card'
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
// `facility` is undefined while the credential status is unknown: no status line then.
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
    <Card className="relative px-5 py-5">
      <h2 className="pe-9 pointer-coarse:pe-12 font-heading font-semibold text-base leading-snug">
        {m.charging_grid_title()}
      </h2>
      {/* After the heading in the DOM so the title is read and tabbed first; absolute, so its place is unchanged. */}
      <div className="absolute end-3 top-3">
        <CredentialsButton
          source="gridTariff"
          label={m.charging_grid_button()}
          onClick={onOpenCredentials}
        />
      </div>
      <p className="text-muted-foreground text-sm">{m.charging_grid_description()}</p>
      {facility ? (
        <p className={cn('text-sm', unreadable && 'text-destructive')}>
          {statusText(facility.origin, unreadable)}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">{m.charging_grid_cadence()}</p>
    </Card>
  )
}
