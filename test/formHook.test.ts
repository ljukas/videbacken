import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// The global form hook is in every form's chunk. The phone input (country-flag-icons +
// libphonenumber-js, ~95 KB gz) must load only where a phone field renders
// (client-performance step 4): pages import PhoneField directly.
it('keeps the phone fields out of the global form hook', () => {
  const hook = readFileSync(new URL('../src/hooks/form.ts', import.meta.url), 'utf8')
  expect(hook).not.toMatch(/PhoneField|phone-input|react-phone-number-input/)
})
