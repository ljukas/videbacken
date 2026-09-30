import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { LoadErrorAlert } from './LoadErrorAlert'

test('is a destructive alert whose retry refetches', async () => {
  const onRetry = vi.fn()
  const { screen } = await renderWithProviders(
    <LoadErrorAlert title="Laddmönstren kunde inte hämtas" onRetry={onRetry} retrying={false} />,
  )
  const alert = screen.getByRole('alert')
  await expect.element(alert).toHaveTextContent('Laddmönstren kunde inte hämtas')
  await expect.element(alert).toHaveTextContent('Kontrollera anslutningen och försök igen.')
  expect(alert.element().className).toMatch(/destructive/)
  await screen.getByRole('button', { name: 'Försök igen' }).click()
  expect(onRetry).toHaveBeenCalledOnce()
})

test('the retry is disabled while the query refetches', async () => {
  const { screen } = await renderWithProviders(
    <LoadErrorAlert title="x" onRetry={() => {}} retrying />,
  )
  await expect.element(screen.getByRole('button', { name: 'Försök igen' })).toBeDisabled()
})
