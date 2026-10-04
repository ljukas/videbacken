import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'
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
import type { IntegrationSource } from '~/lib/integrationHealth'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { RecentRunsTable, type Run } from './RecentRunsTable'

// Admin-only sync history of one source (the last 20 runs), collapsed by default — it's a
// diagnostic, not something to read on every visit.
export function RecentRunsCard({ source, runs }: { source: IntegrationSource; runs: Run[] }) {
  const [open, setOpen] = useState(false)
  const sourceName = integrationSourceName(source)
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card>
        <CardHeader>
          <CardTitle>{m.charging_runs_title({ source: sourceName })}</CardTitle>
          <CardDescription>{m.charging_runs_description({ source: sourceName })}</CardDescription>
          <CardAction>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={m.charging_runs_toggle({ source: sourceName })}
              >
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
            <RecentRunsTable runs={runs} />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
