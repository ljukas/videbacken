import { TextField, type TextFieldPropsWithout } from './TextField'

// A decimal field. It stays a text input (type="number" mangles Swedish
// commas and localized input), with a decimal soft keyboard by default; the
// form's schema parses the string (see `~/lib/parseDecimal`). The unit, if
// any, sits in the trailing suffix ("öre/kWh", "%"). Override `inputMode` for
// a whole number (`numeric`) or a value that can be negative (`text`: iOS's
// decimal pad has no minus key).
export function NumberField({ inputMode = 'decimal', ...props }: TextFieldPropsWithout<'type'>) {
  return <TextField {...props} type="text" inputMode={inputMode} />
}
