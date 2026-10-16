import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAppForm } from '~/hooks/form'
import { TextareaField } from './TextareaField'

// Bound like the phone field: rendered inside AppField, not registered in fieldComponents.
function Harness({ description }: { description?: string }) {
  const form = useAppForm({
    defaultValues: { note: '' },
    // FieldError renders `{ message }` issues (the Standard Schema shape), not bare strings.
    validators: {
      onChange: ({ value }) =>
        value.note.length > 3 ? { fields: { note: { message: 'För lång' } } } : undefined,
    },
  })
  return (
    <form.AppField
      name="note"
      children={() => <TextareaField label="Anteckning" description={description} />}
    />
  )
}

test('the label names the textarea, the description describes it, typing binds', async () => {
  const screen = await render(<Harness description="0 av 500 tecken" />)
  const box = screen.getByRole('textbox', { name: 'Anteckning' })
  await expect.element(box).toHaveAccessibleDescription('0 av 500 tecken')
  expect(box.element().tagName).toBe('TEXTAREA')
  await box.fill('Hej')
  await expect.element(box).toHaveValue('Hej')
})

test('an error marks it invalid and is announced with it', async () => {
  const screen = await render(<Harness />)
  const box = screen.getByRole('textbox', { name: 'Anteckning' })
  // A change marks the field touched and runs the onChange validator.
  await box.fill('Hej då')
  await expect.element(screen.getByText('För lång')).toBeVisible()
  await expect.element(box).toHaveAttribute('aria-invalid', 'true')
  await expect.element(box).toHaveAccessibleDescription('För lång')
})
