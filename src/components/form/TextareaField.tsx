import { useStore } from '@tanstack/react-form'
import type { ReactNode } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '~/components/ui/field'
import { Textarea } from '~/components/ui/textarea'
import { useFieldContext } from '~/hooks/form'

type Props = {
  label: string
  /** Hint announced with the textarea (e.g. a live character count). */
  description?: ReactNode
  placeholder?: string
  rows?: number
}

// A multi-line text field. Not registered in hooks/form.ts's fieldComponents: everything there
// ships in every form's chunk (/login's too). Render it inside AppField; it binds through
// useFieldContext, like the phone field.
export function TextareaField({ label, description, placeholder, rows = 3 }: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
  const id = field.name
  const descriptionId = `${id}-description`
  const errorId = `${id}-error`
  const describedBy =
    [description ? descriptionId : null, isInvalid ? errorId : null].filter(Boolean).join(' ') ||
    undefined
  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        name={id}
        rows={rows}
        // The textarea grows with its content (field-sizing-content): capped, then it scrolls.
        className="max-h-48 overflow-y-auto"
        placeholder={placeholder}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        aria-invalid={isInvalid}
        aria-describedby={describedBy}
        disabled={isSubmitting}
      />
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      <FieldError id={errorId} errors={field.state.meta.errors} />
    </Field>
  )
}
