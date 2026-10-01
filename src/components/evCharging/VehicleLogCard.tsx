import { UploadIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import { m } from '~/paraglide/messages'
import { formatDate } from './format'
import { LoadErrorAlert, type LoadErrorQuery, loadFailed } from './LoadErrorAlert'

type Props = {
  /** What the imported log covers; null when nothing is imported, undefined while unknown. */
  coverage: { from: Date; to: Date; count: number } | null | undefined
  /** The coverage read; when it failed there is no "none imported" claim (ADR-0016). */
  loadError?: LoadErrorQuery
  onImport: () => void
}

// Admin-only: the car's own charging log decides which Zaptec sessions are
// "our car" (ADR-0021). Shows how much of it is loaded and opens the import.
export function VehicleLogCard({ coverage, loadError, onImport }: Props) {
  const failed = loadError !== undefined && loadFailed(loadError)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.charging_vehicle_log_title()}</h2>
        </CardTitle>
        <CardDescription>{m.charging_vehicle_log_description()}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={onImport}>
            <UploadIcon />
            {m.charging_vehicle_import_button()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {failed && loadError ? (
          <LoadErrorAlert title={m.charging_vehicle_log_error_title()} query={loadError} />
        ) : coverage ? (
          <p>
            {m.charging_vehicle_log_coverage({
              count: coverage.count,
              from: formatDate(coverage.from),
              to: formatDate(coverage.to),
            })}
          </p>
        ) : coverage === null ? (
          <p className="text-muted-foreground">{m.charging_vehicle_log_none()}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}
