import { useStore } from '@tanstack/react-form'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Field, FieldDescription, FieldError, FieldLabel } from '~/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { useFieldContext } from '~/hooks/form'
import { initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

export type UserOption = {
  id: string
  name: string
  image: string | null
}

type Props = {
  label: string
  description?: string
  placeholder?: string
  users: ReadonlyArray<UserOption>
}

export function UserSelectField({ label, description, placeholder, users }: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid

  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Select
        value={field.state.value || undefined}
        onValueChange={(v) => field.handleChange(v)}
        disabled={isSubmitting}
      >
        <SelectTrigger id={field.name} aria-invalid={isInvalid} className="w-full">
          <SelectValue placeholder={placeholder ?? m.form_user_placeholder()} />
        </SelectTrigger>
        <SelectContent>
          {users.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              <span className="flex items-center gap-2">
                <Avatar className="size-5">
                  {u.image ? (
                    <AvatarImage src={u.image} alt={u.name} width={20} height={20} />
                  ) : null}
                  <AvatarFallback className="text-xs">{initials(u.name)}</AvatarFallback>
                </Avatar>
                {u.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={field.state.meta.errors} />
    </Field>
  )
}
