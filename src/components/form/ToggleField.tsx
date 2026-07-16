import { useStore } from '@tanstack/react-form'
import { useId } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '~/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { useFieldContext } from '~/hooks/form'

type Option = { value: string; label: string }

type Props = {
  label: string
  description?: string
  options: ReadonlyArray<Option>
}

export function ToggleField({ label, description, options }: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
  const labelId = useId()

  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel id={labelId} htmlFor={field.name}>
        {label}
      </FieldLabel>
      <ToggleGroup
        id={field.name}
        type="single"
        variant="segmented"
        spacing={2}
        value={field.state.value}
        onValueChange={(next) => {
          if (!next) return
          field.handleChange(next)
        }}
        onBlur={field.handleBlur}
        disabled={isSubmitting}
        aria-labelledby={labelId}
        aria-invalid={isInvalid}
        className="w-full"
      >
        {options.map(({ value, label: optLabel }) => (
          <ToggleGroupItem key={value} value={value} className="flex-1">
            {optLabel}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={field.state.meta.errors} />
    </Field>
  )
}
