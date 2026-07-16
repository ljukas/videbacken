import { useStore } from '@tanstack/react-form'
import { Field, FieldDescription, FieldError, FieldLabel } from '~/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { useFieldContext } from '~/hooks/form'

type Option = { value: string; label: string }

type Props = {
  label: string
  description?: string
  placeholder?: string
  options: ReadonlyArray<Option>
}

export function SelectField({ label, description, placeholder, options }: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid

  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Select
        value={field.state.value}
        onValueChange={(v) => field.handleChange(v)}
        disabled={isSubmitting}
      >
        <SelectTrigger id={field.name} aria-invalid={isInvalid} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map(({ value, label: optLabel }) => (
            <SelectItem key={value} value={value}>
              {optLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={field.state.meta.errors} />
    </Field>
  )
}
