import { ZapIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty'
import { Skeleton } from '~/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { Estimated } from './Estimated'
import { formatDuration, formatOneDecimal, formatSek, formatTime } from './format'
import { SessionLink } from './SessionLink'
import { SyncNowButton } from './SyncNowButton'

type Session = RouterOutputs['evCharging']['sessions']['sessions'][number]
type SessionCost = RouterOutputs['evCharging']['sessionCosts'][number]

// Counted sessions, newest first. The parent owns the growing `limit`; "Visa
// fler" asks for the next page while the server reports `hasMore`. Empty →
// the shared `Empty` (ADR-0016) with the one obvious next action — sync —
// offered to admins only (`onSync` is only passed for admins).
export function SessionList({
  sessions,
  hasMore,
  onShowMore,
  loadingMore,
  onSync,
  syncing = false,
  costs,
}: {
  sessions: Session[]
  hasMore: boolean
  onShowMore: () => void
  loadingMore: boolean
  onSync?: () => void
  syncing?: boolean
  /**
   * The cost column, present once the page shows cost at all. `pending`: rows
   * without an entry are still loading (a placeholder), not missing a price.
   */
  costs?: { byId: ReadonlyMap<string, SessionCost>; pending: boolean }
}) {
  if (sessions.length === 0) {
    return (
      <Empty className="brand-wash rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ZapIcon />
          </EmptyMedia>
          <EmptyTitle>{m.charging_sessions_empty_title()}</EmptyTitle>
          <EmptyDescription>{m.charging_sessions_empty_description()}</EmptyDescription>
        </EmptyHeader>
        {onSync ? (
          <EmptyContent>
            <SyncNowButton onSync={onSync} pending={syncing} variant="default" />
          </EmptyContent>
        ) : null}
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border bg-surface-raised">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.charging_sessions_col_date()}</TableHead>
              {/* On a phone the time moves under the date, so the cost fits. */}
              <TableHead className="hidden sm:table-cell">
                {m.charging_sessions_col_time()}
              </TableHead>
              {/* Duration is derivable from start–end, so it's the first to go on a phone. */}
              <TableHead className="hidden sm:table-cell">
                {m.charging_sessions_col_duration()}
              </TableHead>
              <TableHead className="text-right">{m.charging_sessions_col_energy()}</TableHead>
              {costs ? (
                <TableHead className="text-right">{m.charging_sessions_col_cost()}</TableHead>
              ) : null}
              <TableHead className="hidden text-right md:table-cell">
                {m.charging_sessions_col_peak()}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="whitespace-nowrap">
                  <SessionLink sessionId={s.id} startAt={s.startAt} />
                  <div className="text-muted-foreground text-xs tabular-nums sm:hidden">
                    {timeRange(s)}
                  </div>
                </TableCell>
                <TableCell className="hidden whitespace-nowrap tabular-nums sm:table-cell">
                  {timeRange(s)}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap sm:table-cell">
                  {formatDuration(s.startAt, s.endAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {formatOneDecimal(s.energyKwh)} kWh
                </TableCell>
                {costs ? (
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    <SessionCostCell cost={costs.byId.get(s.id)} pending={costs.pending} />
                  </TableCell>
                ) : null}
                <TableCell className="hidden whitespace-nowrap text-right tabular-nums md:table-cell">
                  {s.peakKw != null ? `${formatOneDecimal(s.peakKw)} kW` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {/* The cost column's marks, spelled out for whoever can't hover a title. */}
      {costs && sessions.some((s) => costs.byId.get(s.id)?.estimated) ? (
        <p className="text-muted-foreground text-xs">{m.charging_sessions_cost_legend()}</p>
      ) : null}
      {costs && sessions.some((s) => costs.byId.get(s.id)?.complete === false) ? (
        <p className="text-muted-foreground text-xs">{m.charging_sessions_cost_legend_missing()}</p>
      ) : null}
      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={onShowMore} disabled={loadingMore}>
            {m.charging_sessions_show_more()}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

const timeRange = (s: Session) => `${formatTime(s.startAt)}–${formatTime(s.endAt)}`

// Total incl VAT, with the spot share under it from `sm` up. "≈" marks a
// session priced from its total alone (no hourly values; the legend under the
// table says so); "—" (with the reason for screen readers and on hover) when
// a price or the tariff is missing — never 0 kr. A row whose cost is still
// loading gets a placeholder instead of that dash.
function SessionCostCell({ cost, pending }: { cost: SessionCost | undefined; pending: boolean }) {
  if (!cost && pending) {
    return (
      <span className="inline-flex justify-end">
        <Skeleton className="h-4 w-14" />
        <span className="sr-only">{m.charging_sessions_cost_loading()}</span>
      </span>
    )
  }
  if (!cost?.complete) {
    return (
      <span className="text-muted-foreground" title={m.charging_sessions_cost_unknown()}>
        —<span className="sr-only"> {m.charging_sessions_cost_unknown()}</span>
      </span>
    )
  }
  return (
    <div className="flex flex-col items-end">
      <Estimated estimated={cost.estimated}>{formatSek(cost.totalSek, 2)}</Estimated>
      <span className="hidden text-muted-foreground text-xs sm:inline">
        {m.charging_sessions_cost_spot({ spot: formatSek(cost.spotSek, 2) })}
      </span>
    </div>
  )
}
