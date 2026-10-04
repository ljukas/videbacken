import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { m } from '~/paraglide/messages'

// Which year the monthly chart shows. `years` comes from the overview
// (years with counted sessions, always including the current year, newest first).
export function YearSelector({
  years,
  value,
  onChange,
}: {
  years: number[]
  value: number
  onChange: (year: number) => void
}) {
  // A `?year=` with no data isn't in `years`; keep it selectable so the
  // trigger never renders blank.
  const options = years.includes(value) ? years : [...years, value].sort((a, b) => b - a)
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger size="sm" className="w-auto" aria-label={m.charging_year_label()}>
        {/* Rendered explicitly so SSR already shows the year (Radix fills it in only
            after hydration) and the trigger keeps one width. */}
        <SelectValue>{value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((year) => (
          <SelectItem key={year} value={String(year)}>
            {year}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
