import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId } from 'react'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import type { Vehicle, VehicleSource } from '~/lib/evCharging/vehicle'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'

const VEHICLE_LABEL: Record<Vehicle, () => string> = {
  ours: m.charging_vehicle_ours,
  other: m.charging_vehicle_other,
}
const SOURCE_LABEL: Record<VehicleSource, () => string> = {
  default: m.charging_vehicle_source_default,
  skoda: m.charging_vehicle_source_skoda,
  skoda_live: m.charging_vehicle_source_skoda_live,
  admin: m.charging_vehicle_source_admin,
}
// The select's value for "no admin tag": the automatic rule decides.
const AUTO = 'auto'

// Who charged one session and why (ADR-0021). Admins change it inline: one
// field, saved immediately with a toast (ADR-0016), no dialog. The select is
// controlled by the saved props, so a failed save leaves it on the stored value.
export function SessionVehicle({
  sessionId,
  vehicle,
  vehicleSource,
  isAdmin,
}: {
  sessionId: string
  vehicle: Vehicle
  vehicleSource: VehicleSource
  isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const labelId = useId()
  const save = useMutation(
    orpc.evCharging.setSessionVehicle.mutationOptions({
      onSuccess: () => toast.success(m.charging_vehicle_saved()),
      onError: () => toast.error(m.charging_vehicle_save_error()),
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() }),
    }),
  )
  const stored = vehicleSource === 'admin' ? vehicle : AUTO
  // Until the refetch lands the stored props are stale: show what was just chosen.
  const shown = save.isPending && save.variables ? (save.variables.vehicle ?? AUTO) : stored
  const summary = `${VEHICLE_LABEL[vehicle]()} · ${SOURCE_LABEL[vehicleSource]()}`
  return (
    <div aria-busy={save.isPending} className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span id={labelId} className="text-muted-foreground">
        {m.charging_vehicle_who_label()}
      </span>
      <span>{summary}</span>
      {isAdmin ? (
        <Select
          value={shown}
          // Not `disabled`: that would drop focus to <body> as Radix returns it to
          // the trigger. Guard double submits instead and dim the trigger.
          onValueChange={(v) => {
            if (save.isPending) return
            save.mutate({ sessionId, vehicle: v === AUTO ? null : (v as Vehicle) })
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-auto min-w-32 aria-disabled:opacity-50"
            aria-labelledby={labelId}
            aria-disabled={save.isPending}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ours">{m.charging_vehicle_ours()}</SelectItem>
            <SelectItem value="other">{m.charging_vehicle_other()}</SelectItem>
            <SelectItem value={AUTO}>{m.charging_vehicle_auto()}</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}
