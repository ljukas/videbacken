import { useStore } from '@tanstack/react-form'
import type { ComponentProps, KeyboardEventHandler, ReactNode } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '~/components/ui/input-group'
import { useFieldContext } from '~/hooks/form'

type LabelProps =
  | { label: string; labelledBy?: undefined }
  | {
      label?: undefined
      /**
       * Id of a label rendered outside the field (e.g. a row header that also holds a badge): the
       * field renders no label of its own, so the text appears once, and the input is named by it.
       */
      labelledBy: string
    }

type BaseProps = {
  /** Hint announced with the input; may hold several lines (e.g. a status and a hint). */
  description?: ReactNode
  /** Where the hint sits: under the input (default) or between the label and the input. */
  descriptionPlacement?: 'above' | 'below'
  type?: ComponentProps<typeof Input>['type']
  /** Soft-keyboard hint, e.g. `decimal` for a comma-friendly number field. */
  inputMode?: ComponentProps<typeof Input>['inputMode']
  autoComplete?: string
  placeholder?: string
  autoFocus?: boolean
  /** Disabled on top of the always-on disable while the form submits. */
  disabled?: boolean
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
   * Non-editable text pinned to the trailing edge of the input (e.g. a unit
   * such as "öre/kWh"). When set, the field renders as an input group.
   */
  suffix?: string
  /**
   * The input's DOM id and name, when the field name alone isn't unique on the
   * page (default: the field name). The hint and error ids derive from it.
   */
  inputId?: string
  /** Ids of elements outside the field that also describe the input, announced first. */
  describedBy?: string
  /** Extra `data-*` attributes on the input (e.g. password-manager opt-outs). */
  inputData?: Record<`data-${string}`, string>
}

type Props = BaseProps & LabelProps

/** TextField's props without `K`, keeping the label-or-labelledBy choice (a plain `Omit` would merge it away). */
export type TextFieldPropsWithout<K extends keyof BaseProps> = Omit<BaseProps, K> & LabelProps

export function TextField({
  label,
  labelledBy,
  description,
  descriptionPlacement = 'below',
  type = 'text',
  inputMode,
  autoComplete,
  placeholder,
  autoFocus,
  disabled,
  inputClassName,
  inputSize,
  srOnlyLabel,
  onKeyDown,
  orientation = 'vertical',
  fieldClassName,
  suffix,
  inputId,
  describedBy: externalDescribedBy,
  inputData,
}: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid

  // The unit suffix, hint and error are announced with the input (the suffix
  // is otherwise only visual), so "Energiskatt" reads as "… öre/kWh".
  const id = inputId ?? field.name
  const suffixId = `${id}-suffix`
  const descriptionId = `${id}-description`
  const errorId = `${id}-error`
  const describedBy =
    [
      externalDescribedBy ?? null,
      suffix ? suffixId : null,
      description ? descriptionId : null,
      isInvalid ? errorId : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined

  const sharedInputProps = {
    ...inputData,
    id,
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
    name: id,
    type,
    inputMode,
    autoComplete,
    placeholder,
    autoFocus,
    onKeyDown,
    value: field.state.value,
    onBlur: field.handleBlur,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => field.handleChange(e.target.value),
    'aria-invalid': isInvalid,
    disabled: disabled || isSubmitting,
  }

  // Above the input it is no longer the label's follower: drop FieldDescription's
  // pull-up (`nth-last-2:-mt-1`), which would otherwise come and go with the error.
  const descriptionNode = description ? (
    <FieldDescription
      id={descriptionId}
      className={descriptionPlacement === 'above' ? 'nth-last-2:mt-0' : undefined}
    >
      {description}
    </FieldDescription>
  ) : null

  return (
    <Field data-invalid={isInvalid} orientation={orientation} className={fieldClassName}>
      {label !== undefined ? (
        <FieldLabel htmlFor={id} className={srOnlyLabel ? 'sr-only' : undefined}>
          {label}
        </FieldLabel>
      ) : null}
      {descriptionPlacement === 'above' ? descriptionNode : null}
      {suffix ? (
        <InputGroup>
          <InputGroupInput className={inputClassName} {...sharedInputProps} />
          <InputGroupAddon align="inline-end">
            <InputGroupText id={suffixId}>{suffix}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <Input size={inputSize} className={inputClassName} {...sharedInputProps} />
      )}
      {descriptionPlacement === 'below' ? descriptionNode : null}
      <FieldError id={errorId} errors={field.state.meta.errors} />
    </Field>
  )
}
