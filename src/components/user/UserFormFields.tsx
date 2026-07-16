import { z } from 'zod'
import { FieldGroup } from '~/components/ui/field'
import { withFieldGroup } from '~/hooks/form'
import { nameField, phoneField } from '~/lib/orpc/userProfileSchema'
import { m } from '~/paraglide/messages'

// Email is intentionally absent from the editable field set: it is the
// magic-link login identity and immutable after invite (see ADR-0017). The edit
// dialog shows it read-only for context. This group is also reused by the future
// onboarding flow, which likewise never edits email.
export const userFieldsDefaults: {
  name: string
  phone: string
  role: 'user' | 'admin'
} = {
  name: '',
  phone: '',
  role: 'user',
}

export const userFieldsSchema = z.object({
  // name/phone are the shared validators (see ~/lib/orpc/userProfileSchema) so
  // this form can't validate differently from the server procedures.
  name: nameField,
  phone: phoneField,
  role: z.enum(['user', 'admin'], { error: () => m.validation_role_required() }),
})

export type UserFieldsValues = z.infer<typeof userFieldsSchema>

export const userFieldsMap = {
  name: 'name',
  phone: 'phone',
  role: 'role',
} as const

export const UserFormFields = withFieldGroup({
  defaultValues: userFieldsDefaults,
  render: function Render({ group }) {
    // Built in render, not at module level, so the labels follow the active locale.
    const roleOptions = [
      { value: 'user', label: m.user_role_sailor() },
      { value: 'admin', label: m.user_role_admin() },
    ] as const
    return (
      <FieldGroup>
        <group.AppField
          name="name"
          children={(field) => <field.TextField label={m.user_field_name()} autoComplete="name" />}
        />
        <group.AppField
          name="phone"
          children={(field) => <field.PhoneField label={m.user_field_phone()} />}
        />
        <group.AppField
          name="role"
          children={(field) => (
            <field.ToggleField label={m.user_field_role()} options={roleOptions} />
          )}
        />
      </FieldGroup>
    )
  },
})
