import { useQuery } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { LoadErrorAlert, type LoadErrorQuery } from './LoadErrorAlert'

const failed = (over: Partial<LoadErrorQuery> = {}): LoadErrorQuery => ({
  data: undefined,
  errorUpdateCount: 1,
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

test.each([
  ['a first load in flight', { errorUpdateCount: 0, isFetching: true }],
  ['data from an earlier success', { data: 'kept' }],
] as const)('renders nothing for %s', async (_, over) => {
  const { screen } = await renderWithProviders(<LoadErrorAlert title="x" query={failed(over)} />)
  expect(screen.getByRole('alert').elements()).toHaveLength(0)
})

// A real query, not a fake result: refetching a query that has no data resets
// it to `pending` with `error: null`, so the alert must survive that reset.
function Section({ queryFn }: { queryFn: () => Promise<string> }) {
  const query = useQuery({ queryKey: ['section'], queryFn })
  return query.data ? <p>{query.data}</p> : <LoadErrorAlert title="x" query={query} />
}

test('stays up, retry disabled, while a retry of a failed load is in flight', async () => {
  let resolveRetry: (value: string) => void = () => {}
  const queryFn = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('down'))
    .mockImplementationOnce(() => new Promise((resolve) => (resolveRetry = resolve)))
  const { screen } = await renderWithProviders(<Section queryFn={queryFn} />)
  const retry = screen.getByRole('button', { name: 'Försök igen' })
  await retry.click()
  await expect.poll(() => queryFn.mock.calls.length).toBe(2)
  await expect.element(screen.getByRole('alert')).toBeVisible()
  await expect.element(retry).toBeDisabled()
  resolveRetry('loaded')
  await expect.element(screen.getByText('loaded')).toBeVisible()
  expect(screen.getByRole('alert').elements()).toHaveLength(0)
})
