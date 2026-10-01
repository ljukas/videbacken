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
import { formatCount, formatDate } from './format'

type Props = {
  /** What the imported log covers; null when nothing is imported yet. */
  coverage: { from: Date; to: Date; count: number } | null
  onImport: () => void
}

// Admin-only: the car's own charging log decides which Zaptec sessions are
// "our car" (ADR-0021). Shows how much of it is loaded and opens the import.
export function VehicleLogCard({ coverage, onImport }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.charging_vehicle_log_title()}</h2>
        </CardTitle>
        <CardDescription>{m.charging_vehicle_log_description()}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={onImport}>
            {m.charging_vehicle_import_button()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm">
        {coverage ? (
          <p>
            {m.charging_vehicle_log_coverage({
              count: formatCount(coverage.count),
              from: formatDate(coverage.from),
              to: formatDate(coverage.to),
            })}
          </p>
        ) : (
          <p className="text-muted-foreground">{m.charging_vehicle_log_none()}</p>
        )}
      </CardContent>
    </Card>
  )
}
