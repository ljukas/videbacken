import { useStore } from '@tanstack/react-form'
import type { ComponentProps } from 'react'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { useFormContext } from '~/hooks/form'
import { useDelayedFlag } from '~/hooks/useDelayedFlag'
import { cn } from '~/lib/utils'

// Hold off on the pending spinner until the submit has actually been running this
// long. Our saves are usually well under this, so a fast submit shows no loader at
// all (a spinner that flashes for <~1s reads as a glitch, not progress); only a
// genuinely slow save reveals it. See the loader-delay UX pattern.
const PENDING_DELAY_MS = 300

type Props = {
  label: string
  pendingLabel?: string
  className?: string
  variant?: ComponentProps<typeof Button>['variant']
  size?: ComponentProps<typeof Button>['size']
}

export function SubmitButton({ label, pendingLabel, className, variant, size }: Props) {
  const form = useFormContext()
  const canSubmit = useStore(form.store, (s) => s.canSubmit)
  const isSubmitting = useStore(form.store, (s) => s.isSubmitting)
  const showPending = useDelayedFlag(isSubmitting, PENDING_DELAY_MS)

  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      // Stay functionally disabled the whole time it's submitting — TanStack Form
      // has no internal double-submit guard, it relies on this.
      disabled={!canSubmit || isSubmitting}
      // ...but keep full opacity (override the base `disabled:opacity-50`) until the
      // loader is actually shown, so a fast save doesn't flash a dim. Keys off
      // isSubmitting/showPending only — never canSubmit — so the invalid-state dim
      // (when NOT submitting) is untouched.
      className={cn(isSubmitting && !showPending && 'disabled:opacity-100', className)}
    >
      {showPending ? <Spinner data-icon="inline-start" /> : null}
      {showPending && pendingLabel ? pendingLabel : label}
    </Button>
  )
}
