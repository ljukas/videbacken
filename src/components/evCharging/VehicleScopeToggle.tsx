import { useId } from 'react'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { m } from '~/paraglide/messages'
import { MetricToggle } from './MetricToggle'

// Display order: the default first. The vocabulary's own order (VEHICLE_SCOPES) is unchanged.
const OPTIONS: { value: VehicleScope; label: () => string }[] = [
  { value: 'all', label: m.charging_vehicle_scope_all },
  { value: 'ours', label: m.charging_vehicle_scope_ours },
  { value: 'other', label: m.charging_vehicle_scope_other },
]

// Whose sessions a charging view shows (ADR-0021): a page filter, labelled so it
// reads as one rather than as a control of whatever sits next to it. One option is always on.
export function VehicleScopeToggle({
  value,
  onChange,
}: {
  value: VehicleScope
  onChange: (v: VehicleScope) => void
}) {
  const labelId = useId()
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span id={labelId} className="text-muted-foreground text-sm">
        {m.charging_vehicle_scope_label()}
      </span>
      <MetricToggle
        value={value}
        options={OPTIONS.map((o) => ({ value: o.value, label: o.label() }))}
        onChange={onChange}
        aria-labelledby={labelId}
      />
    </div>
  )
}
