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
import { formatCount, formatRunDuration, formatRunTime } from './format'

export type Run = RouterOutputs['evCharging']['recentRuns'][number]

const TRIGGER_LABEL: Record<Run['trigger'], () => string> = {
  cron: m.charging_runs_trigger_cron,
  admin: m.charging_runs_trigger_admin,
}

// A failure is the neutral outline pill with a red dot, like SyncStateBadge:
// the destructive Badge's red-on-red text is under 4.5:1.
const OUTCOME: Record<Run['outcome'], { label: () => string; failed: boolean }> = {
  ok: { label: m.charging_runs_outcome_ok, failed: false },
  failed: { label: m.charging_runs_outcome_failed, failed: true },
  error: { label: m.charging_runs_outcome_error, failed: true },
}

function OutcomeBadge({ outcome }: { outcome: Run['outcome'] }) {
  const { label, failed } = OUTCOME[outcome]
  if (!failed) return <Badge variant="secondary">{label()}</Badge>
  return (
    <Badge variant="outline" className="gap-1.5">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />
      {label()}
    </Badge>
  )
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
              {formatRunTime(run.startedAt)}
            </TableCell>
            <TableCell className="hidden sm:table-cell">{TRIGGER_LABEL[run.trigger]()}</TableCell>
            <TableCell>
              <OutcomeBadge outcome={run.outcome} />
            </TableCell>
            <TableCell className="hidden whitespace-nowrap text-right tabular-nums md:table-cell">
              {formatRunDuration(run.durationMs)}
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">
              {formatCount(run.upserted)}
            </TableCell>
            {/* Wraps rather than widening the phone sheet past its width. */}
            <TableCell className="whitespace-normal break-all font-mono text-xs">
              {run.errorCode ?? '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
