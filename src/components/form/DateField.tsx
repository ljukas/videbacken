import type { ComponentProps } from 'react'
import { TextField } from './TextField'

// A calendar-day field: the native date input, whose value is always a
// 'YYYY-MM-DD' string (locale-independent), which is what the form stores.
export function DateField(props: Omit<ComponentProps<typeof TextField>, 'type' | 'inputMode'>) {
  return <TextField {...props} type="date" />
}
