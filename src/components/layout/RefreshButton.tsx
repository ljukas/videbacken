import { RefreshCwIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'

// A small button with a refresh icon that spins while `pending`: the "Synka nu"
// syncs and every failed read's "Försök igen".
export function RefreshButton({
  onClick,
  pending,
  label,
  variant = 'outline',
  'aria-label': ariaLabel,
  keepFocusWhilePending = false,
}: {
  onClick: () => void
  pending: boolean
  label: string
  variant?: 'outline' | 'default'
  /** Names the button when several sit on one screen ("Synka nu, Zaptec": the visible label first, WCAG 2.5.3). */
  'aria-label'?: string
  /**
   * While pending, mark the button aria-disabled (and ignore clicks) instead of
   * `disabled`, so a keyboard user who just pressed it keeps focus there rather
   * than being dropped to <body> — for screens with several of these side by side.
   */
  keepFocusWhilePending?: boolean
}) {
  const softDisabled = keepFocusWhilePending && pending
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={softDisabled ? undefined : onClick}
      disabled={pending && !keepFocusWhilePending}
      aria-disabled={softDisabled || undefined}
      aria-label={ariaLabel}
      className={cn(softDisabled && 'cursor-not-allowed opacity-50')}
    >
      <RefreshCwIcon className={cn(pending && 'animate-spin motion-reduce:animate-none')} />
      {label}
    </Button>
  )
}
