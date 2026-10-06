import { TextField, type TextFieldPropsWithout } from './TextField'

// A decimal field. It stays a text input (type="number" mangles Swedish
// commas and localized input), with a decimal soft keyboard; the form's
// schema parses the string (see `~/lib/parseDecimal`). The unit, if any,
// sits in the trailing suffix ("öre/kWh", "%").
export function NumberField(props: TextFieldPropsWithout<'type' | 'inputMode'>) {
  return <TextField {...props} type="text" inputMode="decimal" />
}
