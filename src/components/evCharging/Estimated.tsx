import type * as React from 'react'
import { m } from '~/paraglide/messages'

// A figure marked "≈" when it was priced from the session's total alone (no
// hourly values), with the reason for screen readers and on hover. Exact
// figures pass through unmarked.
export function Estimated({
  estimated,
  children,
}: {
  estimated: boolean
  children: React.ReactNode
}) {
  return (
    <span title={estimated ? m.charging_sessions_cost_estimated() : undefined}>
      {estimated ? '≈ ' : null}
      {children}
      {estimated ? (
        <span className="sr-only"> ({m.charging_sessions_cost_estimated()})</span>
      ) : null}
    </span>
  )
}
