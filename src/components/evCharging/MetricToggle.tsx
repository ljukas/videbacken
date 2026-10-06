import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'

export type MetricOption<T extends string> = { value: T; label: string; ariaLabel?: string }

/** The group's accessible name: a string, or the id of a visible label. */
type GroupLabel = { 'aria-label': string } | { 'aria-labelledby': string }

/** A single-choice switch between a chart's metrics (kWh ↔ kr, kWh ↔ plugged in). */
export function MetricToggle<T extends string>({
  value,
  options,
  onChange,
  itemClassName,
  ...label
}: {
  value: T
  options: MetricOption<T>[]
  onChange: (value: T) => void
  /** Opt-in item styling (e.g. a larger size); the default stays the compact `sm`. */
  itemClassName?: string
} & GroupLabel) {
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
      {...label}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className={itemClassName}
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
