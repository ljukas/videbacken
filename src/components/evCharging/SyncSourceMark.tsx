import {
  CarFrontIcon,
  ChartLineIcon,
  EvChargerIcon,
  type LucideIcon,
  SunMediumIcon,
} from 'lucide-react'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { cn } from '~/lib/utils'

// Each integration's visual identity on the Datakällor panel: what the source
// gives us (an icon, not the company's logo) in its own --source-* tone.
// Exhaustive switch with no default — a new source is a compile error until it
// gets an icon and a tone. Tones are literal class strings so Tailwind sees them.
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
      // A stronger light wash: yellow at /12 all but vanishes on a white card.
      return {
        Icon: SunMediumIcon,
        tone: 'bg-source-emaldo/15 text-source-emaldo dark:bg-source-emaldo/20',
      }
  }
}

/**
 * The source's tinted icon square, a fixed 40px. Decorative: the source name
 * always sits beside it. A span, so it's valid inside phrasing content.
 */
export function SyncSourceMark({ source }: { source: IntegrationSource }) {
  const { Icon, tone } = identity(source)
  return (
    <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', tone)}>
      <Icon className="size-5" aria-hidden="true" />
    </span>
  )
}
