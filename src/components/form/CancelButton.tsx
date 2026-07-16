import type { ComponentProps } from 'react'
import { Button } from '~/components/ui/button'
import { useFormContext } from '~/hooks/form'

type Props = Omit<ComponentProps<typeof Button>, 'type' | 'disabled'>

// `form.state.isSubmitting` read directly in render is not reactive (TanStack
// Form only re-renders through Subscribe/useStore), so a plain
// `<Button disabled={form.state.isSubmitting}>` never actually disables.
// This bound component subscribes properly; use it for cancel/close actions
// that must be inert while the form submits.
export function CancelButton({ variant = 'outline', children, ...props }: Props) {
  const form = useFormContext()

  return (
    <form.Subscribe
      selector={(state) => state.isSubmitting}
      children={(isSubmitting) => (
        <Button type="button" variant={variant} disabled={isSubmitting} {...props}>
          {children}
        </Button>
      )}
    />
  )
}
