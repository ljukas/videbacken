import { TextField, type TextFieldPropsWithout } from './TextField'

// A calendar-day field: the native date input, whose value is always a
// 'YYYY-MM-DD' string (locale-independent), which is what the form stores.
export function DateField(props: TextFieldPropsWithout<'type' | 'inputMode'>) {
  return <TextField {...props} type="date" />
}
