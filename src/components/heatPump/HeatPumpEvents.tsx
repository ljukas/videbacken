import { MoreVerticalIcon, NotebookPenIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { formatDay } from '~/components/evCharging/format'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel, type HeatPumpUnitRef } from './eventCopy'

export type HeatPumpEventsAdmin = {
  onNew: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

type Props = {
  /** Newest first, as `heatPump.events.list` returns them. */
  events: readonly HeatPumpEventDto[]
  units: readonly HeatPumpUnitRef[]
  /** Admin actions; omitted for everyone else (the card is then read-only, ADR-0017). */
  admin?: HeatPumpEventsAdmin
}

// The heat pumps' event log (ADR-0027 decision 10): what was done and when, newest first.
// Everyone sees it; only admins get add / edit / delete. Empty → the shared Empty (ADR-0016)
// with the one next action for admins. The admin controls carry `data-no-skeleton`: the page's
// skeleton capture leaves them out, so a member's skeleton has no button bones.
export function HeatPumpEvents({ events, units, admin }: Props) {
  return (
    <Card>
      <CardHeader>
        {/* As the Förbrukning card's heading (EnergySummaryCard), not CardTitle's default size. */}
        <CardTitle className="font-semibold text-lg">
          <h2>{m.heat_pump_events_title()}</h2>
        </CardTitle>
        <CardDescription>{m.heat_pump_events_description()}</CardDescription>
        {admin && events.length > 0 ? (
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              onClick={admin.onNew}
              data-no-skeleton
            >
              <PlusIcon />
              {m.heat_pump_events_add()}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <Empty className="rounded-lg border py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <NotebookPenIcon />
              </EmptyMedia>
              <EmptyTitle>{m.heat_pump_events_empty_title()}</EmptyTitle>
              <EmptyDescription>
                {admin
                  ? m.heat_pump_events_empty_description_admin()
                  : m.heat_pump_events_empty_description()}
              </EmptyDescription>
            </EmptyHeader>
            {admin ? (
              <EmptyContent>
                <Button
                  size="sm"
                  className="pointer-coarse:h-11"
                  onClick={admin.onNew}
                  data-no-skeleton
                >
                  <PlusIcon />
                  {m.heat_pump_events_add()}
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y">
            {events.map((e) => {
              const kind = eventKindLabel(e.kind)
              const date = formatDay(e.occurredOn)
              const unit = eventUnitLabel(e.heatPumpId, units)
              return (
                <li key={e.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span className="whitespace-nowrap font-medium tabular-nums">{date}</span>
                      <span aria-hidden className="text-muted-foreground">
                        ·
                      </span>
                      <span>{unit}</span>
                      <Badge variant="secondary">{kind}</Badge>
                    </div>
                    {e.note ? (
                      <p className="whitespace-pre-line break-words text-muted-foreground text-sm">
                        {e.note}
                      </p>
                    ) : null}
                  </div>
                  {admin ? (
                    // Always visible (not hover-revealed): with a handful of rows the menu is the
                    // only edit affordance, and touch has no hover.
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="pointer-coarse:size-11 shrink-0"
                          aria-label={m.heat_pump_event_actions_for({ kind, date, unit })}
                          data-no-skeleton
                        >
                          <MoreVerticalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="pointer-coarse:min-h-11"
                          onSelect={() => admin.onEdit(e.id)}
                        >
                          <PencilIcon />
                          {m.common_edit()}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          className="pointer-coarse:min-h-11"
                          onSelect={() => admin.onDelete(e.id)}
                        >
                          <Trash2Icon />
                          {m.heat_pump_event_delete_action()}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
