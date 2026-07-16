import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useUploadQueue } from '~/components/document/upload/UploadQueueProvider'
import { Button } from '~/components/ui/button'
import { Progress } from '~/components/ui/progress'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

const AUTO_HIDE_MS = 4000

/**
 * The hovering upload tray, bottom-right. Reads the page-persistent queue and
 * shows one total progress bar across every queued file plus a compact per-file
 * list. While files upload it stays put; once everything has settled it shows a
 * summary and auto-hides after a moment — unless something failed, in which case
 * it stays until dismissed.
 */
export function UploadQueueBox() {
  const { items, dismiss } = useUploadQueue()
  const [interacting, setInteracting] = useState(false)

  const total = items.length
  const done = items.filter((it) => it.status === 'done').length
  const errored = items.filter((it) => it.status === 'error').length
  const settled = total > 0 && done + errored === total

  // Sum across the files we still expect to complete (errors are excluded so a
  // failure doesn't peg the bar below 100% forever).
  const totalBytes = items.reduce(
    (sum, it) => (it.status === 'error' ? sum : sum + it.sizeBytes),
    0,
  )
  const loadedBytes = items.reduce(
    (sum, it) => (it.status === 'error' ? sum : sum + Math.min(it.loaded, it.sizeBytes)),
    0,
  )
  const pct = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0

  // Auto-hide once everything succeeded — but never while the user is hovering
  // or keyboard-focused inside the tray, so it can't vanish from under the pointer.
  // Leaving (mouse out / blur) re-runs this and restarts the timer.
  useEffect(() => {
    if (!settled || errored > 0 || interacting) return
    const timer = setTimeout(dismiss, AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [settled, errored, interacting, dismiss])

  if (total === 0) return null

  const heading = !settled
    ? m.upload_progress_heading({ done, total })
    : errored === 0
      ? done === 1
        ? m.upload_done_single({ count: done })
        : m.upload_done_multi({ count: done })
      : m.upload_done_with_errors({ done, errored })

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => setInteracting(true)}
      onMouseLeave={() => setInteracting(false)}
      onFocusCapture={() => setInteracting(true)}
      onBlurCapture={() => setInteracting(false)}
      className="fixed inset-x-4 bottom-4 z-50 rounded-lg border bg-card text-card-foreground shadow-lg sm:inset-x-auto sm:right-4 sm:w-96"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="truncate font-medium text-sm">{heading}</span>
        {settled ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={dismiss}
            aria-label={m.common_close()}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>

      {!settled ? (
        <div className="px-3 py-2">
          <Progress value={pct} aria-label={m.upload_total_progress_label({ pct })} />
        </div>
      ) : null}

      <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto px-3 py-2">
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-2 text-sm">
            <StatusIcon status={it.status} />
            <span
              className={cn('truncate', it.status === 'error' && 'text-muted-foreground')}
              title={it.name}
            >
              {it.name}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StatusIcon({ status }: { status: 'pending' | 'uploading' | 'done' | 'error' }) {
  switch (status) {
    case 'done':
      return <CircleCheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
    case 'error':
      return <CircleAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
    default:
      return (
        <LoaderCircleIcon
          className={cn(
            'size-4 shrink-0 text-muted-foreground',
            status === 'uploading' && 'animate-spin',
          )}
          aria-hidden="true"
        />
      )
  }
}
