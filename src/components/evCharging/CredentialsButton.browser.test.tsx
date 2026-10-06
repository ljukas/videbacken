import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { renderWithProviders } from '~test/browser/render'
import { CredentialsButton } from './CredentialsButton'

const LABEL = 'Inloggning för Škoda'

const view = () => (
  <>
    <button type="button">elsewhere</button>
    <CredentialsButton source="skoda" label={LABEL} onClick={() => {}} />
  </>
)

// Lets a tooltip that is about to open (delay 0) render before checking it didn't.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

test('its name is the label, with the tooltip closed', async () => {
  const { screen } = await renderWithProviders(view())
  await expect.element(screen.getByRole('button', { name: LABEL })).toBeVisible()
  expect(screen.getByRole('tooltip').elements()).toHaveLength(0)
})

test('keyboard focus shows the tooltip', async () => {
  const { screen } = await renderWithProviders(view())
  await screen.getByRole('button', { name: 'elsewhere' }).click()
  await userEvent.keyboard('{Tab}')
  await expect.element(screen.getByRole('button', { name: LABEL })).toHaveFocus()
  await expect.element(screen.getByRole('tooltip')).toBeInTheDocument()
})

test('hovering shows the tooltip', async () => {
  const { screen } = await renderWithProviders(view())
  await screen.getByRole('button', { name: LABEL }).hover()
  await expect.element(screen.getByRole('tooltip')).toBeInTheDocument()
})

test('focus put back after a pointer interaction (a dialog closed by click) shows no tooltip', async () => {
  const { screen } = await renderWithProviders(view())
  // The pointer clicks elsewhere and stays there, like a dialog's Cancel.
  await screen.getByRole('button', { name: 'elsewhere' }).click()
  const button = screen.getByRole('button', { name: LABEL })
  button.element().focus()
  await expect.element(button).toHaveFocus()
  await settle()
  expect(screen.getByRole('tooltip').elements()).toHaveLength(0)
})
