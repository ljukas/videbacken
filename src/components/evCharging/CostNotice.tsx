import { InfoIcon } from 'lucide-react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { m } from '~/paraglide/messages'

export type CostNoticeReason = 'noTariff' | 'unpriced'

// Why the page shows no cost, said once above the tiles instead of in every
// tile: no tariff period yet (admins get the button that adds one), or
// periods exist but nothing charged so far has both a price and a tariff.
export function CostNotice({
  reason,
  onAddTariff,
}: {
  reason: CostNoticeReason
  /** Admins only: opens the new-period dialog. */
  onAddTariff?: () => void
}) {
  const text =
    reason === 'unpriced'
      ? m.charging_cost_notice_unpriced()
      : onAddTariff
        ? m.charging_cost_notice_setup_admin()
        : m.charging_cost_notice_setup_member()
  return (
    <Alert>
      <InfoIcon />
      <AlertDescription className="flex flex-col items-start gap-2">
        <div>{text}</div>
        {reason === 'noTariff' && onAddTariff ? (
          <Button size="sm" variant="outline" onClick={onAddTariff}>
            {m.charging_cost_notice_setup_action()}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
