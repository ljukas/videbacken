import { useStore } from '@tanstack/react-form'
import type { Country, Value } from 'react-phone-number-input'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { PhoneInput } from '~/components/ui/phone-input'
import { useFieldContext } from '~/hooks/form'
import { cn } from '~/lib/utils'

type Props = {
  label: string
  autoFocus?: boolean
  defaultCountry?: Country
}

/**
 * Phone field with a floating label, for the large login/onboarding layout: the
 * country-flag + international number control (see `PhoneInput`) grown to the tall
 * `xl` box, with the label sitting as a small caption inside the *number* side —
 * never over the flag — and brand-tinting on focus.
 *
 * It stays permanently in the floated position (which is exactly `FloatingTextField`'s
 * "filled" state) rather than resting centered: the composed input always carries a
 * "+46" calling-code prefix, so a centered label would overlap it and the
 * `:placeholder-shown` trick `FloatingTextField` uses can't detect "empty" here. The
 * label clears the country button with a fixed start offset — the button width is
 * constant (fixed-width flag + chevron, independent of the selected country). See
 * ADR-0015 / ADR-0017.
 */
export function FloatingPhoneField({ label, autoFocus, defaultCountry = 'SE' }: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid

  return (
    <Field data-invalid={isInvalid}>
      <div className="group relative">
        <PhoneInput
          id={field.name}
          name={field.name}
          international
          defaultCountry={defaultCountry}
          size="xl"
          autoFocus={autoFocus}
          // Single space stops RPNInput from rendering an example-number placeholder.
          placeholder=" "
          // Grow both fused subcontrols to the tall floating-label box; reserve top
          // padding on the number input for the floated caption to sit above the value.
          countryButtonClassName="h-14"
          inputClassName="h-14 pt-5 pb-1.5"
          value={(field.state.value || undefined) as Value | undefined}
          onChange={(v) => field.handleChange((v ?? '') as string)}
          onBlur={field.handleBlur}
          disabled={isSubmitting}
          aria-invalid={isInvalid}
        />
        <FieldLabel
          htmlFor={field.name}
          className={cn(
            // Small caption pinned to the top edge of the number side (left offset
            // clears the country button); brand-tinted while the control is focused.
            'pointer-events-none absolute top-2 left-[4.5rem] text-muted-foreground text-xs',
            'transition-colors group-focus-within:text-brand motion-reduce:transition-none',
          )}
        >
          {label}
        </FieldLabel>
      </div>
      <FieldError errors={field.state.meta.errors} />
    </Field>
  )
}
