import { createFormHook, createFormHookContexts } from '@tanstack/react-form'
import { CancelButton } from '~/components/form/CancelButton'
import { DateField } from '~/components/form/DateField'
import { FloatingTextField } from '~/components/form/FloatingTextField'
import { NumberField } from '~/components/form/NumberField'
import { SelectField } from '~/components/form/SelectField'
import { SubmitButton } from '~/components/form/SubmitButton'
import { TextField } from '~/components/form/TextField'
import { ToggleField } from '~/components/form/ToggleField'
import { UserSelectField } from '~/components/form/UserSelectField'

export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts()

// The phone fields stay out of fieldComponents: everything registered here ships in
// every form's chunk, and the phone input is ~95 KB gz. Pages with a phone field
// import it from components/form directly and render it inside AppField (it binds
// through useFieldContext, like every field here).
export const { useAppForm, withForm, withFieldGroup } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TextField,
    NumberField,
    DateField,
    FloatingTextField,
    SelectField,
    ToggleField,
    UserSelectField,
  },
  formComponents: { SubmitButton, CancelButton },
})

// App code that needs reactive form state outside a bound component (e.g. an
// effect keyed on `isSubmitting`) reads it through this re-export, so
// `@tanstack/react-form` stays imported only here and in `src/components/form/*`
// (ADR-0005).
export { useStore } from '@tanstack/react-form'
