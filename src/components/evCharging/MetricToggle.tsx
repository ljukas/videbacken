import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'

export type MetricOption<T extends string> = { value: T; label: string; ariaLabel?: string }

/** A single-choice switch between a chart's metrics (kWh ↔ kr, kWh ↔ plugged in). */
export function MetricToggle<T extends string>({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
}: {
  value: T
  options: MetricOption<T>[]
  onChange: (value: T) => void
  'aria-label': string
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix fires '' when the active item is re-pressed; keep one selected.
      onValueChange={(v) => {
        const picked = options.find((o) => o.value === v)
        if (picked) onChange(picked.value)
      }}
      variant="outline"
      size="sm"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} aria-label={o.ariaLabel}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
