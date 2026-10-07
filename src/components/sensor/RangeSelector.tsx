import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import type { SeriesRange } from '~/lib/sensor/range'
import { m } from '~/paraglide/messages'

const RANGE_LABEL: Record<SeriesRange, () => string> = {
  '24h': m.sensors_range_24h,
  '1w': m.sensors_range_1w,
  '1m': m.sensors_range_1m,
  '3m': m.sensors_range_3m,
  '6m': m.sensors_range_6m,
  '1y': m.sensors_range_1y,
  all: m.sensors_range_all,
}

// Display order (matches the spec's 24h → all time progression).
const ORDER: SeriesRange[] = ['24h', '1w', '1m', '3m', '6m', '1y', 'all']

export function RangeSelector({
  value,
  onChange,
}: {
  value: SeriesRange
  onChange: (r: SeriesRange) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix fires '' when the active item is re-pressed; ignore that so a range
      // is always selected.
      onValueChange={(v) => {
        if (v) onChange(v as SeriesRange)
      }}
      variant="outline"
      // Separate pills, not a joined bar: on a phone the seven ranges wrap into a
      // 4-column grid (never a sideways scroll); from `sm` they sit in one row.
      spacing={1}
      className="grid w-full grid-cols-4 sm:flex sm:w-auto sm:flex-wrap"
      aria-label={m.sensors_range_label()}
    >
      {ORDER.map((r) => (
        <ToggleGroupItem key={r} value={r} className="h-10 px-3 text-sm">
          {RANGE_LABEL[r]()}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
