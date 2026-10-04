import {
  CarFrontIcon,
  ChartLineIcon,
  EvChargerIcon,
  type LucideIcon,
  SunMediumIcon,
} from 'lucide-react'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

// Each integration's visual identity on the Datakällor panel: what the source
// gives us (an icon, not the company's logo) in its own tone. Exhaustive
// switches with no default — a new source is a compile error until it gets an
// icon, a tone and copy here. Tones are literal class strings so Tailwind sees them.
function identity(source: IntegrationSource): { Icon: LucideIcon; tone: string } {
  switch (source) {
    case 'zaptec':
      return {
        Icon: EvChargerIcon,
        tone: 'bg-source-zaptec/12 text-source-zaptec dark:bg-source-zaptec/20',
      }
    case 'elpris':
      return {
        Icon: ChartLineIcon,
        tone: 'bg-source-elpris/12 text-source-elpris dark:bg-source-elpris/20',
      }
    case 'skoda':
      return {
        Icon: CarFrontIcon,
        tone: 'bg-source-skoda/12 text-source-skoda dark:bg-source-skoda/20',
      }
    case 'emaldo':
      return {
        Icon: SunMediumIcon,
        tone: 'bg-source-emaldo/15 text-source-emaldo dark:bg-source-emaldo/20',
      }
  }
}

/** The source's tinted icon square. Decorative: the source name sits beside it. */
export function SyncSourceMark({
  source,
  className,
}: {
  source: IntegrationSource
  className?: string
}) {
  const { Icon, tone } = identity(source)
  return (
    <div
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-lg',
        tone,
        className,
      )}
    >
      <Icon className="size-5" aria-hidden="true" />
    </div>
  )
}

/** What the source provides ("Laddsessioner"). */
export function syncSourceRole(source: IntegrationSource): string {
  switch (source) {
    case 'zaptec':
      return m.charging_source_role_zaptec()
    case 'elpris':
      return m.charging_source_role_elpris()
    case 'skoda':
      return m.charging_source_role_skoda()
    case 'emaldo':
      return m.charging_source_role_emaldo()
  }
}

/** How often its cron fetches it (the crons in vite.config.ts). */
export function syncSourceCadence(source: IntegrationSource): string {
  switch (source) {
    case 'zaptec':
      return m.charging_source_cadence_zaptec()
    case 'elpris':
      return m.charging_source_cadence_elpris()
    case 'skoda':
      return m.charging_source_cadence_skoda()
    case 'emaldo':
      return m.charging_source_cadence_emaldo()
  }
}
