import type * as React from 'react'
import { useId } from 'react'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import type { EnergyPeriod } from '~/lib/houseEnergy/period'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { PeriodControl, periodLabel } from './PeriodControl'

type YearMonth = { year: number; month: number }

// The Energi pages' Summering card (steps 1b, 1c, 2): the heading, the period
// control, a polite announcement of each period change, and the body, dimmed
// while another year loads or after a failed read. The control stays live.
export function EnergySummaryCard({
  period,
  monthsWithReadings,
  now,
  onChange,
  dimmed,
  busy,
  children,
}: {
  period: EnergyPeriod
  monthsWithReadings: string[]
  now: YearMonth
  onChange: (p: EnergyPeriod) => void
  dimmed: boolean
  /** aria-busy on the body: another year is loading (not a failed read). */
  busy: boolean
  children: React.ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <Card>
        {/* As tall for every period: the control's label cell is as wide as its widest label, its buttons a fixed 40 px. */}
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={headingId} className="font-semibold text-lg">
            {m.energy_tiles_heading()}
          </h2>
          <PeriodControl
            period={period}
            monthsWithReadings={monthsWithReadings}
            current={now}
            onChange={onChange}
          />
        </CardHeader>
        {/* Announces each period change (the label sits inside a button, which screen readers don't re-read).
            Outside the busy figures, so it isn't held back while a year loads. */}
        <p data-slot="period-announcement" aria-live="polite" className="sr-only">
          {periodLabel(period, now)}
        </p>
        {/* The control stays live while a year loads: only the figures dim. */}
        <CardContent
          className={cn('transition-opacity', dimmed && 'opacity-60')}
          aria-busy={busy || undefined}
        >
          {children}
        </CardContent>
      </Card>
    </section>
  )
}
