import { useStore } from '@tanstack/react-form'
import { CalendarIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Calendar } from '~/components/ui/calendar'
import { Field, FieldDescription, FieldError, FieldLabel } from '~/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import { useFieldContext } from '~/hooks/form'
import { formatDate, getDateFnsLocale } from '~/lib/i18n/format'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type Props = {
  label: string
  description?: string
}

export function DateField({ label, description }: Props) {
  const field = useFieldContext<Date>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
  const [open, setOpen] = useState(false)

  const value = field.state.value

  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={field.name}
            type="button"
            variant="outline"
            aria-invalid={isInvalid}
            disabled={isSubmitting}
            className={cn('w-full justify-start font-normal', !value && 'text-muted-foreground')}
          >
            <CalendarIcon data-icon="inline-start" />
            {value ? formatDate(value) : m.form_date_placeholder()}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value}
            onSelect={(next) => {
              if (next) {
                // Normalize to UTC midnight — the DB `date` column has no TZ
                // and we want the picked calendar day regardless of locale.
                const utc = new Date(Date.UTC(next.getFullYear(), next.getMonth(), next.getDate()))
                field.handleChange(utc)
                setOpen(false)
              }
            }}
            locale={getDateFnsLocale()}
            weekStartsOn={1}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={field.state.meta.errors} />
    </Field>
  )
}
