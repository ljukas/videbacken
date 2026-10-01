import type * as React from 'react'
import { NOISE_THRESHOLD_KWH } from '~/lib/evCharging/counting'
import { m } from '~/paraglide/messages'
import { formatAgo, formatThreshold } from './format'

// Page heading: title, what the page counts (the noise threshold is the same
// constant the service filters on), and when data last synced successfully.
// `title` names the view (defaults to the section title); `action` is the
// admin-only "Synka nu" slot.
export function ChargingHeading({
  title = m.charging_title(),
  lastSuccessAt,
  action,
  note,
}: {
  title?: string
  lastSuccessAt: Date | null
  action?: React.ReactNode
  /** A line under the description, e.g. which vehicles the page covers. */
  note?: string
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-2">
        <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">{title}</h1>
        <p className="max-w-2xl text-muted-foreground text-sm">
          {m.charging_description()}{' '}
          {m.charging_noise_note({ threshold: formatThreshold(NOISE_THRESHOLD_KWH) })}
        </p>
        {note ? <p className="text-muted-foreground text-sm">{note}</p> : null}
        {/* The relative time is measured against `new Date()`, which differs
            slightly between SSR and hydration — a benign mismatch, suppressed
            the same way as CurrentReadingTiles' "last seen". */}
        <p className="text-muted-foreground text-xs" suppressHydrationWarning>
          {lastSuccessAt
            ? m.charging_last_synced({ time: formatAgo(lastSuccessAt) })
            : m.charging_never_synced()}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  )
}
