import { Link } from '@tanstack/react-router'
import { m } from '~/paraglide/messages'
import { formatDate, formatTime } from './format'

// A session's date, linking to its page. Underlined at rest so it reads as a
// link on touch too; the accessible name adds the start time, which tells two
// sessions on one day apart.
export function SessionLink({ sessionId, startAt }: { sessionId: string; startAt: Date }) {
  return (
    <Link
      to="/charging/sessions/$sessionId"
      params={{ sessionId }}
      aria-label={m.charging_session_link_label({
        date: formatDate(startAt),
        time: formatTime(startAt),
      })}
      className="rounded-sm font-medium underline decoration-muted-foreground/40 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {formatDate(startAt)}
    </Link>
  )
}
