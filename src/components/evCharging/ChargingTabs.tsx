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
          aria-current={tab.key === current ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 font-medium text-sm transition-colors',
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
