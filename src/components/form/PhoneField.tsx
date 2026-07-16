import { useStore } from '@tanstack/react-form'
import type { Country, Value } from 'react-phone-number-input'
import { Field, FieldDescription, FieldError, FieldLabel } from '~/components/ui/field'
import { PhoneInput } from '~/components/ui/phone-input'
import { useFieldContext } from '~/hooks/form'

type Props = {
  label: string
  description?: string
  placeholder?: string
  defaultCountry?: Country
  /**
   * Field layout. Defaults to `vertical` (label over control). `responsive`
   * stacks on a narrow field-group and goes label-left at the @md container
   * breakpoint — used for Linear-style settings rows (needs a
   * `@container/field-group` ancestor; pair with `controlClassName` to give the
   * control a fixed width at @md, since `responsive` otherwise collapses it).
   */
  orientation?: 'vertical' | 'horizontal' | 'responsive'
  /** Extra classes on the `Field` wrapper (e.g. row padding inside a card). */
  fieldClassName?: string
  /** Extra classes on the phone control root (e.g. a fixed width in a row). */
  controlClassName?: string
}

export function PhoneField({
  label,
  description,
  placeholder,
  defaultCountry = 'SE',
  orientation = 'vertical',
  fieldClassName,
  controlClassName,
}: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid

  return (
    <Field data-invalid={isInvalid} orientation={orientation} className={fieldClassName}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <PhoneInput
        id={field.name}
        name={field.name}
        international
        defaultCountry={defaultCountry}
        placeholder={placeholder}
        className={controlClassName}
        value={(field.state.value || undefined) as Value | undefined}
        onChange={(v) => field.handleChange((v ?? '') as string)}
        onBlur={field.handleBlur}
        disabled={isSubmitting}
        aria-invalid={isInvalid}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={field.state.meta.errors} />
    </Field>
  )
}
