import { createFormHook, createFormHookContexts } from '@tanstack/react-form'
import { CancelButton } from '~/components/form/CancelButton'
import { DateField } from '~/components/form/DateField'
import { FloatingPhoneField } from '~/components/form/FloatingPhoneField'
import { FloatingTextField } from '~/components/form/FloatingTextField'
import { PhoneField } from '~/components/form/PhoneField'
import { SelectField } from '~/components/form/SelectField'
import { SubmitButton } from '~/components/form/SubmitButton'
import { TextField } from '~/components/form/TextField'
import { ToggleField } from '~/components/form/ToggleField'
import { UserSelectField } from '~/components/form/UserSelectField'

export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts()

export const { useAppForm, withForm, withFieldGroup } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TextField,
    FloatingTextField,
    FloatingPhoneField,
    SelectField,
    PhoneField,
    ToggleField,
    DateField,
    UserSelectField,
  },
  formComponents: { SubmitButton, CancelButton },
})
