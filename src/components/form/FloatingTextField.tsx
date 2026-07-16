import { useStore } from '@tanstack/react-form'
import type { ComponentProps } from 'react'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { useFieldContext } from '~/hooks/form'
import { cn } from '~/lib/utils'

type Props = {
  label: string
  type?: ComponentProps<typeof Input>['type']
  autoComplete?: string
  autoFocus?: boolean
}

/**
 * Email/text field with a floating label: the label rests inside the field and
 * animates up to a small brand-tinted caption on focus or when the field holds a
 * value. Pure CSS — driven by the `:placeholder-shown` trick (the input carries a
 * single-space placeholder so the pseudo-class is true only when empty) plus
 * `peer-focus`, so it needs no React focus/value state. The visually-empty
 * placeholder is ignored by screen readers; the real `<label>` carries the
 * accessible name. Used by the login form (see ADR-0015); other forms use the
 * stacked `TextField`.
 */
export function FloatingTextField({ label, type = 'text', autoComplete, autoFocus }: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid

  return (
    <Field data-invalid={isInvalid}>
      <div className="relative">
        <Input
          id={field.name}
          name={field.name}
          type={type}
          size="xl"
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          // Single space drives :placeholder-shown without showing any hint text.
          placeholder=" "
          className="peer h-14 pt-5 pb-1.5"
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(e.target.value)}
          aria-invalid={isInvalid}
          disabled={isSubmitting}
        />
        <FieldLabel
          htmlFor={field.name}
          className={cn(
            // Resting: centered inside the field, full size, muted.
            'pointer-events-none absolute top-1/2 left-3.5 origin-left -translate-y-1/2 text-base text-muted-foreground',
            'transition-all motion-reduce:transition-none',
            // Floated: small caption pinned to the top edge, brand-tinted on focus.
            'peer-focus:top-2 peer-focus:translate-y-0 peer-focus:text-brand peer-focus:text-xs',
            'peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:translate-y-0 peer-[:not(:placeholder-shown)]:text-xs',
          )}
        >
          {label}
        </FieldLabel>
      </div>
      <FieldError errors={field.state.meta.errors} />
    </Field>
  )
}
