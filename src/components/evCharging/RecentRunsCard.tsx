import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '~/components/ui/collapsible'
import { Empty, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatCount, formatDateTime, formatRunDuration } from './format'

type Run = RouterOutputs['evCharging']['recentRuns'][number]

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

// Admin-only sync history of one source (the last 20 runs), collapsed by default — it's a
// diagnostic, not something to read on every visit. The error code is shown
// raw on purpose: it's the stable identifier admins grep logs for.
export function RecentRunsCard({ source, runs }: { source: IntegrationSource; runs: Run[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card>
        <CardHeader>
          <CardTitle>{m.charging_runs_title()}</CardTitle>
          <CardDescription>
            {m.charging_runs_description({ source: integrationSourceName(source) })}
          </CardDescription>
          <CardAction>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={m.charging_runs_toggle()}>
                <ChevronDownIcon
                  className={cn(
                    'transition-transform motion-reduce:transition-none',
                    open && 'rotate-180',
                  )}
                />
              </Button>
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent>
            {runs.length === 0 ? (
              <Empty className="py-6">
                <EmptyHeader>
                  <EmptyTitle>{m.charging_runs_empty()}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.charging_runs_col_time()}</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      {m.charging_runs_col_trigger()}
                    </TableHead>
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
                      <TableCell className="hidden sm:table-cell">
                        {TRIGGER_LABEL[run.trigger]()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={OUTCOME[run.outcome].variant}>
                          {OUTCOME[run.outcome].label()}
                        </Badge>
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
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
