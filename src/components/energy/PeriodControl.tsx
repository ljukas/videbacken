import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { monthLabel, monthName } from '~/components/evCharging/format'
import { Button } from '~/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import {
  type EnergyPeriod,
  formatPeriod,
  monthKey,
  parsePeriod,
  stepPeriod,
} from '~/lib/houseEnergy/period'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type YearMonth = { year: number; month: number }

function labelOf(p: EnergyPeriod, current: YearMonth): { main: string; soFar: boolean } {
  if (p.kind === 'all') return { main: m.charging_tile_all_time(), soFar: false }
  if (p.kind === 'year')
    return { main: m.energy_period_year({ year: String(p.year) }), soFar: p.year === current.year }
  return {
    main: m.energy_period_month({ month: monthName(p.month), year: String(p.year) }),
    soFar: p.year === current.year && p.month === current.month,
  }
}

// The tiles card's period: ‹ label ⌄ ›. The arrows step within the kind; the
// label opens a picker that never scrolls (spec "The period control"). Every
// label it can show is stacked in one grid cell, so the cell is as wide as the
// widest and the arrows never move (no measuring, SSR-safe).
export function PeriodControl({
  period,
  monthsWithReadings,
  current,
  onChange,
}: {
  period: EnergyPeriod
  monthsWithReadings: string[]
  current: YearMonth
  onChange: (p: EnergyPeriod) => void
}) {
  const [open, setOpen] = useState(false)
  const years = [...new Set(monthsWithReadings.map((k) => Number(k.slice(0, 4))))].sort(
    (a, b) => a - b,
  )
  const stacked: EnergyPeriod[] = [
    ...monthsWithReadings.flatMap((k) => {
      const p = parsePeriod(k)
      return p ? [p] : []
    }),
    ...years.map((year) => ({ kind: 'year', year }) as const),
    { kind: 'all' },
  ]
  // The shown period must always have a label, even if it has no readings.
  const all = stacked.some((p) => formatPeriod(p) === formatPeriod(period))
    ? stacked
    : [...stacked, period]
  const prev = stepPeriod(period, -1, monthsWithReadings)
  const next = stepPeriod(period, 1, monthsWithReadings)
  const unit = period.kind === 'year' ? 'year' : 'month'
  const shown = labelOf(period, current)
  const pick = (p: EnergyPeriod) => {
    setOpen(false)
    onChange(p)
  }

  return (
    <div className="flex w-full items-center gap-0.5 sm:w-auto">
      <Button
        variant="ghost"
        size="icon"
        className="size-10 shrink-0 text-muted-foreground aria-disabled:opacity-50"
        aria-disabled={!prev}
        onClick={() => prev && onChange(prev)}
        aria-label={unit === 'year' ? m.energy_period_prev_year() : m.energy_period_prev_month()}
      >
        <ChevronLeftIcon className="size-5" />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            className="h-10 min-w-0 flex-1 px-3 font-semibold text-base sm:flex-none"
            aria-label={m.energy_period_choose({
              period: `${shown.main}${shown.soFar ? ` (${m.energy_chart_so_far()})` : ''}`,
            })}
          >
            <span data-slot="period-labels" className="grid min-w-0 justify-items-center">
              {all.map((p) => {
                const l = labelOf(p, current)
                const isShown = formatPeriod(p) === formatPeriod(period)
                return (
                  <span
                    key={formatPeriod(p)}
                    aria-hidden={isShown ? undefined : true}
                    className={cn(
                      'col-start-1 row-start-1 min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap',
                      !isShown && 'invisible',
                    )}
                  >
                    {l.main}
                    {l.soFar ? (
                      <span className="ml-1.5 font-normal text-muted-foreground text-sm">
                        ({m.energy_chart_so_far()})
                      </span>
                    ) : null}
                  </span>
                )
              })}
            </span>
            <ChevronDownIcon aria-hidden className="size-[18px] shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          collisionPadding={16}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            const root = e.currentTarget as HTMLElement
            const target =
              root.querySelector<HTMLElement>('[data-month][aria-current]:not([disabled])') ??
              root.querySelector<HTMLElement>('[data-month]:not([disabled])') ??
              root
            target.focus()
          }}
          className="max-h-(--radix-popover-content-available-height) w-[min(20rem,calc(100vw-2rem))] gap-2 overflow-y-auto p-2.5"
          aria-label={m.energy_period_picker()}
        >
          <Picker
            period={period}
            years={years}
            monthsWithReadings={monthsWithReadings}
            current={current}
            onPick={pick}
          />
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon"
        className="size-10 shrink-0 text-muted-foreground aria-disabled:opacity-50"
        aria-disabled={!next}
        onClick={() => next && onChange(next)}
        aria-label={unit === 'year' ? m.energy_period_next_year() : m.energy_period_next_month()}
      >
        <ChevronRightIcon className="size-5" />
      </Button>
    </div>
  )
}

function Picker({
  period,
  years,
  monthsWithReadings,
  current,
  onPick,
}: {
  period: EnergyPeriod
  years: number[]
  monthsWithReadings: string[]
  current: YearMonth
  onPick: (p: EnergyPeriod) => void
}) {
  const [year, setYear] = useState(
    period.kind === 'all' ? (years[years.length - 1] ?? current.year) : period.year,
  )
  const i = years.indexOf(year)
  const selected = formatPeriod(period)
  const choice = (p: EnergyPeriod) =>
    cn(
      'min-h-11 rounded-md border border-transparent text-[15px] outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
      formatPeriod(p) === selected && 'border-brand bg-brand/10 font-semibold text-brand',
    )
  return (
    // PopoverContent is the dialog (Radix sets role="dialog"; it carries the label).
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          disabled={i <= 0}
          onClick={() => setYear(years[i - 1])}
          aria-label={m.energy_period_prev_year()}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
        <span className="font-semibold text-base">{year}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          disabled={i === -1 || i >= years.length - 1}
          onClick={() => setYear(years[i + 1])}
          aria-label={m.energy_period_next_year()}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {Array.from({ length: 12 }, (_, idx) => {
          const month = idx + 1
          const p: EnergyPeriod = { kind: 'month', year, month }
          const soFar = year === current.year && month === current.month
          return (
            <button
              key={month}
              type="button"
              data-month
              disabled={!monthsWithReadings.includes(monthKey(year, month))}
              onClick={() => onPick(p)}
              aria-current={formatPeriod(p) === selected ? 'true' : undefined}
              aria-label={`${monthName(month)} ${year}${soFar ? ` ${m.energy_chart_so_far()}` : ''}`}
              className={cn(choice(p), 'flex flex-col items-center justify-center leading-tight')}
            >
              {monthLabel(month)}
              {soFar ? (
                <span className="text-[13px] text-muted-foreground">{m.energy_chart_so_far()}</span>
              ) : null}
            </button>
          )
        })}
      </div>
      <div className="grid grid-cols-2 gap-1 border-t pt-2">
        <button
          type="button"
          disabled={!years.includes(year)}
          aria-current={selected === formatPeriod({ kind: 'year', year }) ? 'true' : undefined}
          onClick={() => onPick({ kind: 'year', year })}
          className={cn(choice({ kind: 'year', year }), 'border-border')}
        >
          {m.energy_period_whole_year({ year: String(year) })}
        </button>
        <button
          type="button"
          aria-current={period.kind === 'all' ? 'true' : undefined}
          onClick={() => onPick({ kind: 'all' })}
          className={cn(choice({ kind: 'all' }), 'border-border')}
        >
          {m.charging_tile_all_time()}
        </button>
      </div>
    </div>
  )
}
