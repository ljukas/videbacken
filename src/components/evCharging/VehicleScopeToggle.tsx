import { VEHICLE_SCOPES, type VehicleScope } from '~/lib/evCharging/vehicle'
import { m } from '~/paraglide/messages'
import { MetricToggle } from './MetricToggle'

const LABEL: Record<VehicleScope, () => string> = {
  ours: m.charging_vehicle_scope_ours,
  other: m.charging_vehicle_scope_other,
  all: m.charging_vehicle_scope_all,
}

// Whose sessions a charging view shows (ADR-0021). One option is always on.
export function VehicleScopeToggle({
  value,
  onChange,
}: {
  value: VehicleScope
  onChange: (v: VehicleScope) => void
}) {
  return (
    <MetricToggle
      value={value}
      options={VEHICLE_SCOPES.map((scope) => ({ value: scope, label: LABEL[scope]() }))}
      onChange={onChange}
      aria-label={m.charging_vehicle_scope_label()}
    />
  )
}

/** The line under the page heading, so a screenshot or shared link says what the totals cover. */
export function scopeNote(scope: VehicleScope): string | undefined {
  if (scope === 'ours') return m.charging_vehicle_note_ours()
  if (scope === 'other') return m.charging_vehicle_note_other()
  return undefined
}
