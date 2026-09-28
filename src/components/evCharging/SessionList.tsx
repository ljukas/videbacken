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
import { formatDate, formatDuration, formatOneDecimal, formatTime } from './format'
import { SyncNowButton } from './SyncNowButton'

type Session = RouterOutputs['evCharging']['sessions']['sessions'][number]

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
}: {
  sessions: Session[]
  hasMore: boolean
  onShowMore: () => void
  loadingMore: boolean
  onSync?: () => void
  syncing?: boolean
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
              <TableHead>{m.charging_sessions_col_time()}</TableHead>
              {/* Duration is derivable from start–end, so it's the first to go on a phone. */}
              <TableHead className="hidden sm:table-cell">
                {m.charging_sessions_col_duration()}
              </TableHead>
              <TableHead className="text-right">{m.charging_sessions_col_energy()}</TableHead>
              <TableHead className="hidden text-right md:table-cell">
                {m.charging_sessions_col_peak()}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="whitespace-nowrap">{formatDate(s.startAt)}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatTime(s.startAt)}–{formatTime(s.endAt)}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap sm:table-cell">
                  {formatDuration(s.startAt, s.endAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {formatOneDecimal(s.energyKwh)} kWh
                </TableCell>
                <TableCell className="hidden whitespace-nowrap text-right tabular-nums md:table-cell">
                  {s.peakKw != null ? `${formatOneDecimal(s.peakKw)} kW` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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
