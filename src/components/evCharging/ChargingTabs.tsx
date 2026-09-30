import { Link } from '@tanstack/react-router'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

const TABS = [
  { key: 'overview', to: '/charging', label: m.charging_tab_overview },
  { key: 'patterns', to: '/charging/patterns', label: m.charging_tab_patterns },
] as const

// Route links styled as tabs — they switch pages, so not Radix Tabs.
export function ChargingTabs({ current }: { current: 'overview' | 'patterns' }) {
  return (
    <nav aria-label={m.charging_tabs_label()} className="flex gap-1 border-b">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          search={(prev: { year?: number }) => ({ year: prev.year })}
          // Default matching is a prefix match: /charging would also be "active"
          // on /charging/patterns and Link would force aria-current on it.
          activeOptions={{ exact: true }}
          aria-current={tab.key === current ? 'page' : undefined}
          className={cn(
            '-mb-px inline-flex min-h-11 items-center rounded-sm border-b-2 px-3 py-2 font-medium text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
            tab.key === current
              ? 'border-brand text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label()}
        </Link>
      ))}
    </nav>
  )
}
