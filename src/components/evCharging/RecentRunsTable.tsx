import { HistoryIcon } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
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
import { formatCount, formatDateTime, formatRunDuration } from './format'

export type Run = RouterOutputs['evCharging']['recentRuns'][number]

const TRIGGER_LABEL: Record<Run['trigger'], () => string> = {
  cron: m.charging_runs_trigger_cron,
  admin: m.charging_runs_trigger_admin,
}

const OUTCOME: Record<
  Run['outcome'],
  { label: () => string; variant: 'secondary' | 'destructive' }
> = {
  ok: { label: m.charging_runs_outcome_ok, variant: 'secondary' },
  failed: { label: m.charging_runs_outcome_failed, variant: 'destructive' },
  error: { label: m.charging_runs_outcome_error, variant: 'destructive' },
}

// One source's admin sync history (its last runs), or an empty state. The
// error code is shown raw on purpose: it's the stable identifier admins grep
// logs for.
export function RecentRunsTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <Empty className="py-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyTitle>{m.charging_runs_empty()}</EmptyTitle>
          <EmptyDescription>{m.charging_runs_empty_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{m.charging_runs_col_time()}</TableHead>
          <TableHead className="hidden sm:table-cell">{m.charging_runs_col_trigger()}</TableHead>
          <TableHead>{m.charging_runs_col_outcome()}</TableHead>
          <TableHead className="hidden text-right md:table-cell">
            {m.charging_runs_col_duration()}
          </TableHead>
          <TableHead className="hidden text-right sm:table-cell">
            {m.charging_runs_col_upserted()}
          </TableHead>
          <TableHead>{m.charging_runs_col_code()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell className="whitespace-nowrap tabular-nums">
              {formatDateTime(run.startedAt)}
            </TableCell>
            <TableCell className="hidden sm:table-cell">{TRIGGER_LABEL[run.trigger]()}</TableCell>
            <TableCell>
              <Badge variant={OUTCOME[run.outcome].variant}>{OUTCOME[run.outcome].label()}</Badge>
            </TableCell>
            <TableCell className="hidden whitespace-nowrap text-right tabular-nums md:table-cell">
              {formatRunDuration(run.durationMs)}
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">
              {formatCount(run.upserted)}
            </TableCell>
            <TableCell className="font-mono text-xs">{run.errorCode ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
