import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { formatDay } from '~/components/evCharging/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { orpc } from '~/lib/orpc/client'
import { heatPumpEventErrorMessage } from '~/lib/orpc/heatPumpEventErrorMessage'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel, type HeatPumpUnitRef } from './eventCopy'

type Props = {
  open: boolean
  event: HeatPumpEventDto | undefined
  units: readonly HeatPumpUnitRef[]
  onOpenChange: (open: boolean) => void
}

// Confirm before deleting an event: it leaves the log and the day chart (and, from step 4b,
// stops splitting the energy signature).
export function DeleteHeatPumpEventDialog({ open, event: target, units, onOpenChange }: Props) {
  const queryClient = useQueryClient()
  // Keep the last target while the close animation runs (the URL clears first).
  const [shown, setShown] = useState(target)
  if (target && target.id !== shown?.id) setShown(target)
  const event = target ?? shown
  const remove = useMutation(
    orpc.heatPump.events.delete.mutationOptions({
      onSuccess: () => toast.success(m.heat_pump_event_deleted()),
      onError: (err) => {
        // Already gone (another admin deleted it): what was asked for is done.
        if (isDefinedError(err) && err.code === 'EVENT_NOT_FOUND') {
          toast.success(m.heat_pump_event_deleted())
          return
        }
        toast.error(
          isDefinedError(err)
            ? heatPumpEventErrorMessage(err.code)
            : m.heat_pump_event_delete_error(),
        )
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.heatPump.events.key() }),
    }),
  )
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {event ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.heat_pump_event_delete_title()}</AlertDialogTitle>
              <AlertDialogDescription>
                {m.heat_pump_event_delete_confirm({
                  kind: eventKindLabel(event.kind),
                  date: formatDay(event.occurredOn),
                  unit: eventUnitLabel(event.heatPumpId, units),
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(e) => {
                  e.preventDefault()
                  // Instant close; the toast and invalidation reconcile after.
                  remove.mutate({ id: event.id })
                  onOpenChange(false)
                }}
              >
                {m.heat_pump_event_delete_action()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}
