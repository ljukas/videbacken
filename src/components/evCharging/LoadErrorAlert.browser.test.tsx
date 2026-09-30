import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { LoadErrorAlert, type LoadErrorQuery } from './LoadErrorAlert'

const failed = (over: Partial<LoadErrorQuery> = {}): LoadErrorQuery => ({
  isError: true,
  isFetching: false,
  refetch: () => {},
  ...over,
})

test('is a destructive alert whose retry refetches', async () => {
  const refetch = vi.fn()
  const { screen } = await renderWithProviders(
    <LoadErrorAlert title="Laddmönstren kunde inte hämtas" query={failed({ refetch })} />,
  )
  const alert = screen.getByRole('alert')
  await expect.element(alert).toHaveTextContent('Laddmönstren kunde inte hämtas')
  await expect.element(alert).toHaveTextContent('Kontrollera anslutningen och försök igen.')
  expect(alert.element().className).toMatch(/destructive/)
  await screen.getByRole('button', { name: 'Försök igen' }).click()
  expect(refetch).toHaveBeenCalledOnce()
})

test('the retry is disabled while the query refetches', async () => {
  const { screen } = await renderWithProviders(
    <LoadErrorAlert title="x" query={failed({ isFetching: true })} />,
  )
  await expect.element(screen.getByRole('button', { name: 'Försök igen' })).toBeDisabled()
})

test('renders nothing while the query has not failed', async () => {
  const { screen } = await renderWithProviders(
    <LoadErrorAlert title="x" query={failed({ isError: false, isFetching: true })} />,
  )
  expect(screen.getByRole('alert').elements()).toHaveLength(0)
})
