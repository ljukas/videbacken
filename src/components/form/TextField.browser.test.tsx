import type { ComponentProps } from 'react'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAppForm } from '~/hooks/form'
import type { TextField } from './TextField'

const DESCRIPTION = 'Fyra till åtta tecken.'

// A one-field form, as the app binds TextField through `useAppForm`.
function Harness(props: ComponentProps<typeof TextField>) {
  const form = useAppForm({ defaultValues: { code: '' } })
  return (
    <>
      <span id="external-label">Extern etikett</span>
      <form.AppField name="code" children={(field) => <field.TextField {...props} />} />
    </>
  )
}

const follows = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

test('by default the label names the input and the description follows it', async () => {
  const screen = await render(<Harness label="Kod" description={DESCRIPTION} />)
  const input = screen.getByRole('textbox', { name: 'Kod' })
  await expect.element(input).toBeVisible()
  expect(screen.getByText('Kod').element().getAttribute('for')).toBe('code')
  expect(input.element().hasAttribute('aria-labelledby')).toBe(false)
  await expect.element(input).toHaveAccessibleDescription(DESCRIPTION)
  expect(follows(input.element(), screen.getByText(DESCRIPTION).element())).toBe(true)
})

test('labelledBy names the input by an external element and renders no label', async () => {
  const screen = await render(<Harness labelledBy="external-label" />)
  const input = screen.getByRole('textbox', { name: 'Extern etikett' })
  await expect.element(input).toBeVisible()
  expect(input.element().getAttribute('aria-labelledby')).toBe('external-label')
  expect(screen.container.querySelector('label')).toBeNull()
})

test('descriptionPlacement="above" puts the description before the input, still describing it', async () => {
  const screen = await render(
    <Harness label="Kod" description={DESCRIPTION} descriptionPlacement="above" />,
  )
  const input = screen.getByRole('textbox', { name: 'Kod' })
  await expect.element(input).toHaveAccessibleDescription(DESCRIPTION)
  expect(follows(screen.getByText(DESCRIPTION).element(), input.element())).toBe(true)
})
