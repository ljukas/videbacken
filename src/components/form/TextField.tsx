import { useStore } from '@tanstack/react-form'
import type { ComponentProps, KeyboardEventHandler } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '~/components/ui/input-group'
import { useFieldContext } from '~/hooks/form'

type Props = {
  label: string
  description?: string
  type?: ComponentProps<typeof Input>['type']
  autoComplete?: string
  placeholder?: string
  autoFocus?: boolean
  inputClassName?: string
  inputSize?: ComponentProps<typeof Input>['size']
  srOnlyLabel?: boolean
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
  /**
   * Field layout. Defaults to `vertical` (label over control). `responsive`
   * stacks on a narrow field-group and goes label-left at the @md container
   * breakpoint — used for Linear-style settings rows (needs a
   * `@container/field-group` ancestor).
   */
  orientation?: 'vertical' | 'horizontal' | 'responsive'
  /** Extra classes on the `Field` wrapper (e.g. row padding inside a card). */
  fieldClassName?: string
  /**
   * Non-editable text pinned to the trailing edge of the input (e.g. a locked
   * file extension). When set, the field renders as an input group.
   */
  suffix?: string
}

export function TextField({
  label,
  description,
  type = 'text',
  autoComplete,
  placeholder,
  autoFocus,
  inputClassName,
  inputSize,
  srOnlyLabel,
  onKeyDown,
  orientation = 'vertical',
  fieldClassName,
  suffix,
}: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid

  const sharedInputProps = {
    id: field.name,
    name: field.name,
    type,
    autoComplete,
    placeholder,
    autoFocus,
    onKeyDown,
    value: field.state.value,
    onBlur: field.handleBlur,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => field.handleChange(e.target.value),
    'aria-invalid': isInvalid,
    disabled: isSubmitting,
  }

  return (
    <Field data-invalid={isInvalid} orientation={orientation} className={fieldClassName}>
      <FieldLabel htmlFor={field.name} className={srOnlyLabel ? 'sr-only' : undefined}>
        {label}
      </FieldLabel>
      {suffix ? (
        <InputGroup>
          <InputGroupInput className={inputClassName} {...sharedInputProps} />
          <InputGroupAddon align="inline-end">
            <InputGroupText>{suffix}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <Input size={inputSize} className={inputClassName} {...sharedInputProps} />
      )}
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={field.state.meta.errors} />
    </Field>
  )
}
