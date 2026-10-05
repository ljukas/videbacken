import { InfoIcon } from 'lucide-react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { m } from '~/paraglide/messages'
import { SettingsLink } from './SettingsLink'

export type CostNoticeReason = 'noTariff' | 'unpriced'

// Why the page shows no cost, said once above the tiles instead of in every
// tile: no tariff period yet (admins get a link to add one on the settings
// page), or periods exist but nothing charged so far has both a price and a tariff.
export function CostNotice({
  reason,
  canAddTariff = false,
}: {
  reason: CostNoticeReason
  /** Admins only: links to the settings page's new-period dialog. */
  canAddTariff?: boolean
}) {
  const text =
    reason === 'unpriced'
      ? m.charging_cost_notice_unpriced()
      : canAddTariff
        ? m.charging_cost_notice_setup_admin()
        : m.charging_cost_notice_setup_member()
  return (
    <Alert>
      <InfoIcon />
      <AlertDescription className="flex flex-col items-start gap-2">
        <div>{text}</div>
        {reason === 'noTariff' && canAddTariff ? (
          <SettingsLink search={{ dialog: 'tariffNew' }}>
            {m.charging_cost_notice_setup_action()}
          </SettingsLink>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
